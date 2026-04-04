/**
 * Embedded HTTP Server — auto-starts with plugin, serves CLI commands
 *
 * This is NOT a separate process. It runs inside the plugin (or standalone)
 * and provides HTTP endpoints for the CLI to connect to.
 *
 * Users never need to configure or manage this — it just works.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionManager } from './session-manager.js';
import { sanitizeCwd, validateRegex } from './validation.js';
import type { EffortLevel } from './types.js';

import { DEFAULT_SERVER_PORT, MAX_BODY_SIZE, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from './constants.js';

export class EmbeddedServer {
  private server: http.Server | null = null;
  private manager: SessionManager;
  private port: number;
  private authToken: string | null = null;
  private _rateWindows = new Map<string, number[]>();
  private _rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(manager: SessionManager, port?: number) {
    this.manager = manager;
    this.port = port || DEFAULT_SERVER_PORT;
  }

  private _checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const window = this._rateWindows.get(ip) || [];
    const recent = window.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    this._rateWindows.set(ip, recent);
    return recent.length <= RATE_LIMIT_MAX_REQUESTS;
  }

  async start(): Promise<number> {
    // Auth token: opt-in via OPENCLAW_SERVER_TOKEN env var.
    // When set, all requests (except /health) must include Authorization: Bearer <token>.
    // Default: no auth (localhost-only is the primary security boundary).
    const envToken = process.env.OPENCLAW_SERVER_TOKEN;
    if (envToken) {
      this.authToken = envToken;
      // Write token to file for CLI to read
      const tokenDir = path.join(os.homedir(), '.openclaw');
      try {
        if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
        fs.writeFileSync(path.join(tokenDir, 'server-token'), this.authToken, { mode: 0o600 });
      } catch {
        /* best effort */
      }
    } else {
      this.authToken = null;
    }

    this._rateLimitCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, timestamps] of this._rateWindows) {
        const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length === 0) this._rateWindows.delete(ip);
        else this._rateWindows.set(ip, recent);
      }
    }, RATE_LIMIT_WINDOW_MS);
    this._rateLimitCleanupTimer.unref();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port already in use — another instance running, skip
          console.log(`[embedded-server] Port ${this.port} in use, skipping (another instance running)`);
          this.server = null;
          resolve(0);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(
          `[embedded-server] Listening on http://127.0.0.1:${this.port}${this.authToken ? ' (auth enabled)' : ''}`,
        );
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this._rateLimitCleanupTimer) {
      clearInterval(this._rateLimitCleanupTimer);
      this._rateLimitCleanupTimer = null;
    }
    // Only delete token file if it matches our token
    try {
      const tokenPath = path.join(os.homedir(), '.openclaw', 'server-token');
      const stored = fs.readFileSync(tokenPath, 'utf8');
      if (stored === this.authToken) fs.unlinkSync(tokenPath);
    } catch {
      /* ignore */
    }
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS — restrict to localhost origins only
    const origin = req.headers.origin || '';
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(origin);
    if (isLocalhost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const path = url.pathname;

    // Bearer token auth (skip for health checks)
    if (this.authToken && path !== '/health') {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${this.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized — provide Authorization: Bearer <token>' }));
        return;
      }
    }

    // Rate limiting
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!this._checkRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Rate limit exceeded' }));
      return;
    }

    // Read body for POST — require JSON content type (CSRF mitigation)
    if (req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }
      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        this.route(path, parsed, url.searchParams, res);
      });
    } else {
      this.route(path, {}, url.searchParams, res);
    }
  }

  private async route(
    path: string,
    body: Record<string, unknown>,
    query: URLSearchParams,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      // ─── Session Routes ──────────────────────────────────────────

      if (path === '/session/start') {
        if (body.cwd) body.cwd = sanitizeCwd(body.cwd as string);
        const info = await this.manager.startSession(body as Parameters<SessionManager['startSession']>[0]);
        json(200, { ok: true, ...info });
        return;
      }

      if (path === '/session/send') {
        const result = await this.manager.sendMessage(body.name as string, body.message as string, {
          effort: body.effort as EffortLevel | undefined,
          plan: body.plan as boolean | undefined,
          timeout: body.timeout as number | undefined,
        });
        json(200, { ok: true, ...result });
        return;
      }

      if (path === '/session/stop') {
        await this.manager.stopSession(body.name as string);
        json(200, { ok: true });
        return;
      }

      if (path === '/session/list') {
        json(200, { ok: true, sessions: this.manager.listSessions() });
        return;
      }

      if (path === '/session/status') {
        const status = this.manager.getStatus(body.name as string);
        json(200, { ok: true, ...status });
        return;
      }

      if (path === '/session/grep') {
        validateRegex(body.pattern as string);
        const matches = await this.manager.grepSession(
          body.name as string,
          body.pattern as string,
          body.limit as number | undefined,
        );
        json(200, { ok: true, count: matches.length, matches });
        return;
      }

      if (path === '/session/compact') {
        await this.manager.compactSession(body.name as string, body.summary as string | undefined);
        json(200, { ok: true });
        return;
      }

      if (path === '/session/cost') {
        const cost = this.manager.getCost(body.name as string);
        json(200, { ok: true, ...cost });
        return;
      }

      if (path === '/session/model') {
        this.manager.setModel(body.name as string, body.model as string);
        json(200, { ok: true });
        return;
      }

      if (path === '/session/effort') {
        this.manager.setEffort(body.name as string, body.level as EffortLevel);
        json(200, { ok: true });
        return;
      }

      // ─── Agent Teams ─────────────────────────────────────────────

      if (path === '/session/team-list') {
        const response = await this.manager.teamList(body.name as string);
        json(200, { ok: true, response });
        return;
      }

      if (path === '/session/team-send') {
        const result = await this.manager.teamSend(
          body.name as string,
          body.teammate as string,
          body.message as string,
        );
        json(200, { ok: true, ...result });
        return;
      }

      // ─── File Management ─────────────────────────────────────────

      if (path === '/agents') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, agents: this.manager.listAgents(cwd) });
        return;
      }

      if (path === '/agents/create') {
        const p = this.manager.createAgent(
          body.name as string,
          body.cwd as string | undefined,
          body.description as string | undefined,
          body.prompt as string | undefined,
        );
        json(200, { ok: true, path: p });
        return;
      }

      if (path === '/skills') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, skills: this.manager.listSkills(cwd) });
        return;
      }

      if (path === '/skills/create') {
        const p = this.manager.createSkill(
          body.name as string,
          body.cwd as string | undefined,
          body as Record<string, string>,
        );
        json(200, { ok: true, path: p });
        return;
      }

      if (path === '/rules') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, rules: this.manager.listRules(cwd) });
        return;
      }

      if (path === '/rules/create') {
        const p = this.manager.createRule(
          body.name as string,
          body.cwd as string | undefined,
          body as Record<string, string>,
        );
        json(200, { ok: true, path: p });
        return;
      }

      // ─── Health ──────────────────────────────────────────────────

      if (path === '/health') {
        json(200, { ok: true, version: this.manager.getVersion(), sessions: this.manager.listSessions().length });
        return;
      }

      json(404, { ok: false, error: 'Not found' });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  }
}
