/**
 * Persistent Codex Session — wraps OpenAI `codex` CLI
 *
 * Unlike Claude Code, Codex does not maintain a persistent subprocess with
 * streaming JSON I/O.  Each send() spawns a new `codex` process in quiet +
 * full-auto mode.  The "session" is persistent in the sense that:
 *   - Working directory (cwd) carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - The session has consistent lifecycle semantics (start/stop/pause/resume)
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type SessionConfig,
  type SessionStats,
  type EffortLevel,
  type StreamEvent,
  type ISession,
  type SessionSendOptions,
  type TurnResult,
  type CostBreakdown,
  MODEL_ALIASES,
  getModelPricing as _getModelPricingBase,
} from './types.js';

import { MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT } from './constants.js';

function getModelPricing(model?: string) {
  return _getModelPricingBase(model, 'o4-mini');
}

// ─── PersistentCodexSession ─────────────────────────────────────────────────

export class PersistentCodexSession extends EventEmitter implements ISession {
  private options: SessionConfig;
  private codexBin: string;
  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  private currentProc: ChildProcess | null = null;
  private currentRequestId = 0;
  private _startTime: string | null = null;
  private _history: Array<{ time: string; type: string; event: unknown }> = [];

  public sessionId?: string;
  private _stats = {
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    lastActivity: null as string | null,
  };

  constructor(config: SessionConfig, codexBin?: string) {
    super();
    this.codexBin = codexBin || process.env.CODEX_BIN || 'codex';
    this.options = {
      ...config,
      permissionMode: config.permissionMode || 'bypassPermissions',
    };
  }

  get pid(): number | undefined {
    return this.currentProc?.pid ?? undefined;
  }

  get isReady(): boolean {
    return this._isReady;
  }
  get isPaused(): boolean {
    return this._isPaused;
  }
  get isBusy(): boolean {
    return this._isBusy;
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  async start(): Promise<this> {
    // Normalize and ensure CWD exists
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) {
        fs.mkdirSync(this.options.cwd, { recursive: true });
      }
    }

    this.sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit('ready');
    this.emit('init', { type: 'system', subtype: 'init', session_id: this.sessionId });
    return this;
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady) throw new Error('Session not ready. Call start() first.');

    const requestId = ++this.currentRequestId;
    const textMessage = typeof message === 'string' ? message : JSON.stringify(message);

    if (!options.waitForComplete) {
      // Fire-and-forget: spawn in background
      this._runCodex(textMessage, options).catch((err) => this.emit('error', err));
      return { requestId, sent: true };
    }

    this._isBusy = true;
    try {
      return await this._runCodex(textMessage, options);
    } finally {
      this._isBusy = false;
    }
  }

  private async _runCodex(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // Use `codex exec` for non-interactive execution (main `codex` requires TTY)
    const args: string[] = ['exec', '--full-auto', '--skip-git-repo-check'];

    // Model
    const model = this.options.model;
    if (model) args.push('--model', model);

    // CWD via -C flag (exec subcommand supports it)
    if (this.options.cwd) args.push('-C', this.options.cwd);

    // Prompt
    args.push(message);

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const proc = spawn(this.codexBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'], // stdin must be 'ignore' — codex waits for piped stdin
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Codex response'));
        }
      }, timeout);

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        try {
          options.callbacks?.onText?.(chunk);
        } catch {}
        this.emit('text', chunk);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        this.emit('log', `[codex-stderr] ${data.toString()}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;

        if (settled) return;
        settled = true;

        const now = new Date().toISOString();
        this._stats.turns++;
        this._stats.lastActivity = now;

        // Rough token estimate: ~1 token per 4 chars.
        // Error margin: ~30% for English text, higher for code with long identifiers.
        // TODO(codex-cli): Replace with actual usage data when codex gains --usage output.
        const estimatedOutputTokens = Math.ceil(stdout.length / 4);
        const estimatedInputTokens = Math.ceil(message.length / 4);
        this._stats.tokensIn += estimatedInputTokens;
        this._stats.tokensOut += estimatedOutputTokens;
        this._updateCost();

        this._history.push({ time: now, type: 'result', event: { text: stdout, code } });
        if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();

        const event: StreamEvent = {
          type: 'result',
          result: stdout,
          stop_reason: code === 0 ? 'end_turn' : 'error',
        };

        this.emit('result', event);
        this.emit('turn_complete', event);

        if (code !== 0) {
          // Non-zero exit = error, even if there's stdout
          const errMsg = stderr || `Codex exited with code ${code}`;
          reject(new Error(errMsg));
        } else {
          resolve({ text: stdout, event });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this._stats.turns,
      toolCalls: this._stats.toolCalls,
      toolErrors: this._stats.toolErrors,
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      costUsd: Math.round(this._stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this._startTime,
      lastActivity: this._stats.lastActivity,
      contextPercent: 0, // Codex doesn't expose context usage
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  async compact(_summary?: string): Promise<TurnResult> {
    // Codex doesn't support context compaction — no-op
    const event: StreamEvent = { type: 'result', result: 'Codex engine does not support compaction' };
    return { text: event.result as string, event };
  }

  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }

  getCost(): CostBreakdown {
    const pricing = getModelPricing(this.options.model);
    return {
      model: this.options.model || 'o4-mini',
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: 0,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: undefined },
      breakdown: {
        inputCost: (this._stats.tokensIn / 1_000_000) * pricing.input,
        cachedCost: 0,
        outputCost: (this._stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this._stats.costUsd,
    };
  }

  resolveModel(alias: string): string {
    if (MODEL_ALIASES[alias]) return MODEL_ALIASES[alias];
    return alias;
  }

  pause(): void {
    this._isPaused = true;
    this.emit('paused', { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit('resumed', { sessionId: this.sessionId });
  }

  stop(): void {
    if (this.currentProc) {
      try {
        this.currentProc.kill('SIGTERM');
      } catch {}
      this.currentProc = null;
    }
    this._isReady = false;
    this._isPaused = false;
    this.emit('close', 143);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _updateCost(): void {
    const pricing = getModelPricing(this.options.model);
    this._stats.costUsd =
      (this._stats.tokensIn / 1_000_000) * pricing.input + (this._stats.tokensOut / 1_000_000) * pricing.output;
  }
}
