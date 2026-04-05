/**
 * Persistent Cursor Session — wraps `cursor-agent` CLI
 *
 * Like Codex/Gemini, each send() spawns a new `cursor-agent` process in
 * headless print mode. Cursor CLI supports `--output-format stream-json`
 * which provides NDJSON events similar to Gemini's stream protocol.
 *
 * The "session" is persistent in the same sense as Codex:
 *   - Working directory carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - Consistent lifecycle semantics (start/stop/pause/resume)
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
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
  getModelPricing as _getModelPricingBase,
} from './types.js';
import { resolveAlias, estimateTokens } from './models.js';

import { MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT, SESSION_EVENT } from './constants.js';

function getModelPricing(model?: string) {
  return _getModelPricingBase(model, 'claude-sonnet-4-6');
}

// ─── PersistentCursorSession ───────────────────────────────────────────────

export class PersistentCursorSession extends EventEmitter implements ISession {
  private options: SessionConfig;
  private _currentRl: readline.Interface | null = null;
  private cursorBin: string;
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

  constructor(config: SessionConfig, cursorBin?: string) {
    super();
    this.cursorBin = cursorBin || process.env.CURSOR_BIN || 'agent';
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
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) {
        fs.mkdirSync(this.options.cwd, { recursive: true });
      }
    }

    this.sessionId = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
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
      this._runCursor(textMessage, options).catch((err) => this.emit(SESSION_EVENT.ERROR, err));
      return { requestId, sent: true };
    }

    this._isBusy = true;
    try {
      return await this._runCursor(textMessage, options);
    } finally {
      this._isBusy = false;
    }
  }

  private async _runCursor(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // agent -p <prompt> --force --trust --output-format stream-json
    const args: string[] = ['-p', message, '--force', '--trust', '--output-format', 'stream-json'];

    // Model
    if (this.options.model) args.push('--model', this.options.model);

    // Workspace directory (prefer --workspace over cwd for explicit path)
    if (this.options.cwd) args.push('--workspace', this.options.cwd);

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const resultText = { value: '' };
      let stderr = '';
      let settled = false;
      let gotUsageFromEvents = false;

      const proc = spawn(this.cursorBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Cursor response'));
        }
      }, timeout);

      // Parse stream-json output line by line
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, resultText, () => {
            gotUsageFromEvents = true;
          });
        } catch {
          // Non-JSON line — treat as plain text
          resultText.value += line + '\n';
          try {
            options.callbacks?.onText?.(line + '\n');
          } catch {}
          this.emit(SESSION_EVENT.TEXT, line + '\n');
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = data
          .toString()
          .replace(/CURSOR_API_KEY=[^\s]+/g, 'CURSOR_API_KEY=***')
          .replace(/Bearer [a-zA-Z0-9_-]+/g, 'Bearer ***');
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[cursor-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (this._currentRl) {
          this._currentRl.close();
          this._currentRl = null;
        }

        if (settled) return;
        settled = true;

        const now = new Date().toISOString();
        this._stats.turns++;
        this._stats.lastActivity = now;

        // Fallback: estimate tokens if stream events didn't provide usage
        if (!gotUsageFromEvents && resultText.value.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(resultText.value);
          this._updateCost();
        }

        this._history.push({ time: now, type: 'result', event: { text: resultText.value, code } });
        if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();

        const event: StreamEvent = {
          type: 'result',
          result: resultText.value,
          stop_reason: code === 0 ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0 && !resultText.value) {
          reject(new Error(stderr || `Cursor exited with code ${code}`));
        } else if (code !== 0) {
          reject(new Error(stderr || `Cursor exited with code ${code}`));
        } else {
          resolve({ text: resultText.value, event });
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

  // ─── Stream Event Handling ───────────────────────────────────────────────

  private _handleStreamEvent(
    event: Record<string, unknown>,
    options: SessionSendOptions,
    resultText: { value: string },
    markUsageReceived: () => void,
  ): void {
    const type = event.type as string;

    switch (type) {
      case 'system':
        // Init event — extract session_id if available
        if (event.session_id && !this.sessionId?.startsWith('cursor-live-')) {
          this.sessionId = `cursor-live-${event.session_id}`;
        }
        break;

      case 'user':
        // Echo of user prompt — skip
        break;

      case 'assistant': {
        // Cursor format: { type: "assistant", message: { role, content: [{ type, text }] } }
        const msg = event.message as Record<string, unknown> | undefined;
        if (!msg) break;
        const contentArr = msg.content as Array<{ type: string; text?: string }> | undefined;
        if (contentArr) {
          for (const block of contentArr) {
            if (block.type === 'text' && block.text) {
              resultText.value += block.text;
              try {
                options.callbacks?.onText?.(block.text);
              } catch {}
              this.emit(SESSION_EVENT.TEXT, block.text);
            }
          }
        }
        break;
      }

      // Also support generic "message" format for forward compatibility
      case 'message': {
        if (event.role === 'user') break;
        const text = (event.content as string) || '';
        if (text) {
          resultText.value += text;
          try {
            options.callbacks?.onText?.(text);
          } catch {}
          this.emit(SESSION_EVENT.TEXT, text);
        }
        break;
      }

      case 'tool_use':
        this._stats.toolCalls++;
        try {
          options.callbacks?.onToolUse?.(event);
        } catch {}
        this.emit(SESSION_EVENT.TOOL_USE, event);
        break;

      case 'tool_result':
        try {
          options.callbacks?.onToolResult?.(event);
        } catch {}
        if (event.is_error) this._stats.toolErrors++;
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
        break;

      case 'result': {
        // Cursor uses camelCase: inputTokens, outputTokens, cacheReadTokens
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          this._stats.tokensIn += usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0;
          this._stats.tokensOut += usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0;
          const cached = usage.cacheReadTokens || usage.cached_tokens || 0;
          if (cached) this._stats.cachedTokens += cached;
          this._updateCost();
          markUsageReceived();
        }
        // Result text (if not already captured from assistant events)
        const resultStr = event.result as string | undefined;
        if (resultStr && !resultText.value) resultText.value = resultStr;
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[cursor-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        break;
    }
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
      contextPercent: 0,
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  async compact(_summary?: string): Promise<TurnResult> {
    const event: StreamEvent = { type: 'result', result: 'Cursor engine does not support compaction' };
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
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    return {
      model: this.options.model || 'cursor-default',
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: cachedPrice || undefined },
      breakdown: {
        inputCost: (nonCachedIn / 1_000_000) * pricing.input,
        cachedCost: (this._stats.cachedTokens / 1_000_000) * cachedPrice,
        outputCost: (this._stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this._stats.costUsd,
    };
  }

  resolveModel(alias: string): string {
    return resolveAlias(alias);
  }

  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  stop(): void {
    if (this._currentRl) {
      this._currentRl.close();
      this._currentRl = null;
    }
    if (this.currentProc) {
      this.currentProc.stdin?.end();
      this.currentProc.stdout?.destroy();
      this.currentProc.stderr?.destroy();
      try {
        this.currentProc.kill('SIGTERM');
      } catch {}
      this.currentProc = null;
    }
    this._isReady = false;
    this._isPaused = false;
    this.emit(SESSION_EVENT.CLOSE, 143);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _updateCost(): void {
    const pricing = getModelPricing(this.options.model);
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    this._stats.costUsd =
      (nonCachedIn / 1_000_000) * pricing.input +
      (this._stats.cachedTokens / 1_000_000) * cachedPrice +
      (this._stats.tokensOut / 1_000_000) * pricing.output;
  }
}
