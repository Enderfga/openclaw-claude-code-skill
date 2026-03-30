/**
 * Embedded HTTP Server — auto-starts with plugin, serves CLI commands
 *
 * This is NOT a separate process. It runs inside the plugin (or standalone)
 * and provides HTTP endpoints for the CLI to connect to.
 *
 * Users never need to configure or manage this — it just works.
 */

import * as http from 'node:http';
import { SessionManager } from './session-manager.js';
import type { EffortLevel } from './types.js';

const DEFAULT_PORT = 18796;

export class EmbeddedServer {
  private server: http.Server | null = null;
  private manager: SessionManager;
  private port: number;

  constructor(manager: SessionManager, port?: number) {
    this.manager = manager;
    this.port = port || DEFAULT_PORT;
  }

  async start(): Promise<number> {
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
        console.log(`[embedded-server] Listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise(resolve => {
      this.server!.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const path = url.pathname;

    // Read body for POST
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        this.route(path, parsed, url.searchParams, res);
      });
    } else {
      this.route(path, {}, url.searchParams, res);
    }
  }

  private async route(
    path: string, body: Record<string, unknown>,
    query: URLSearchParams, res: http.ServerResponse,
  ): Promise<void> {
    try {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      // ─── Session Routes ──────────────────────────────────────────

      if (path === '/session/start') {
        const info = await this.manager.startSession(body as Parameters<SessionManager['startSession']>[0]);
        json(200, { ok: true, ...info });
        return;
      }

      if (path === '/session/send') {
        const result = await this.manager.sendMessage(
          body.name as string, body.message as string,
          {
            effort: body.effort as EffortLevel | undefined,
            plan: body.plan as boolean | undefined,
            timeout: body.timeout as number | undefined,
          }
        );
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
        const matches = await this.manager.grepSession(
          body.name as string, body.pattern as string, body.limit as number | undefined
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
          body.name as string, body.teammate as string, body.message as string
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
          body.name as string, body.cwd as string | undefined,
          body.description as string | undefined, body.prompt as string | undefined
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
        const p = this.manager.createSkill(body.name as string, body.cwd as string | undefined, body as Record<string, string>);
        json(200, { ok: true, path: p });
        return;
      }

      if (path === '/rules') {
        const cwd = query.get('cwd') || undefined;
        json(200, { ok: true, rules: this.manager.listRules(cwd) });
        return;
      }

      if (path === '/rules/create') {
        const p = this.manager.createRule(body.name as string, body.cwd as string | undefined, body as Record<string, string>);
        json(200, { ok: true, path: p });
        return;
      }

      // ─── Health ──────────────────────────────────────────────────

      if (path === '/health') {
        json(200, { ok: true, version: '2.0.0', sessions: this.manager.listSessions().length });
        return;
      }

      json(404, { ok: false, error: 'Not found' });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  }
}
