/**
 * Persistent Gemini Session — wraps Google `gemini` CLI
 *
 * Like Codex, each send() spawns a new `gemini` process. Unlike Codex,
 * Gemini CLI supports `--output-format stream-json` which provides real
 * token usage data and structured tool call events instead of raw text.
 *
 * The "session" is persistent in the same sense as Codex:
 *   - Working directory carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - Consistent lifecycle semantics (start/stop/pause/resume)
 *
 * @see ISession
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
  return _getModelPricingBase(model, 'gemini-2.5-pro');
}

// ─── PersistentGeminiSession ────────────────────────────────────────────────

export class PersistentGeminiSession extends EventEmitter implements ISession {
  private options: SessionConfig;
  private _currentRl: readline.Interface | null = null;
  private geminiBin: string;
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

  constructor(config: SessionConfig, geminiBin?: string) {
    super();
    this.geminiBin = geminiBin || process.env.GEMINI_BIN || 'gemini';
    this.options = {
      ...config,
      permissionMode: config.permissionMode || 'bypassPermissions',
    };
  }

  /** Process ID of the underlying Gemini CLI subprocess, or undefined if not started. */
  get pid(): number | undefined {
    return this.currentProc?.pid ?? undefined;
  }

  /** Whether the session has authenticated and is ready to receive messages. */
  get isReady(): boolean {
    return this._isReady;
  }
  /** Whether message processing is paused. */
  get isPaused(): boolean {
    return this._isPaused;
  }
  /** Whether the session is currently processing a message. */
  get isBusy(): boolean {
    return this._isBusy;
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  /**
   * Start the Gemini session and initialize the working directory.
   * @returns This session instance
   */
  async start(): Promise<this> {
    // Normalize CWD to prevent path traversal
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) {
        fs.mkdirSync(this.options.cwd, { recursive: true });
      }
    }

    this.sessionId = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
    return this;
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  /**
   * Send a message to the session and wait for a response.
   * @param message - Message text to send
   * @param options - Optional send settings
   * @returns TurnResult (text + event) or { requestId, sent } if waitForComplete is false
   */
  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady) throw new Error('Session not ready. Call start() first.');

    const requestId = ++this.currentRequestId;
    const textMessage = typeof message === 'string' ? message : JSON.stringify(message);

    if (!options.waitForComplete) {
      this._runGemini(textMessage, options).catch((err) => this.emit(SESSION_EVENT.ERROR, err));
      return { requestId, sent: true };
    }

    this._isBusy = true;
    try {
      return await this._runGemini(textMessage, options);
    } finally {
      this._isBusy = false;
    }
  }

  private async _runGemini(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const args: string[] = ['-p', message, '--output-format', 'stream-json'];

    // Permission mode
    if (this.options.permissionMode === 'bypassPermissions' || this.options.dangerouslySkipPermissions) {
      args.push('--yolo');
    } else if (this.options.permissionMode === 'default') {
      args.push('--sandbox');
    }

    // Model
    if (this.options.model) args.push('--model', this.options.model);

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const resultText = { value: '' };
      let stderr = '';
      let settled = false;
      let gotUsageFromEvents = false;

      const proc = spawn(this.geminiBin, args, {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Gemini response'));
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
          .replace(/GEMINI_API_KEY=[^\s]+/g, 'GEMINI_API_KEY=***')
          .replace(/Bearer [a-zA-Z0-9_-]+/g, 'Bearer ***');
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[gemini-stderr] ${sanitized}`);
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

        // Gemini exit codes: 0=success, 53=turn limit, 1=error, 42=input error
        let stopReason = 'end_turn';
        if (code === 53) stopReason = 'turn_limit';
        else if (code !== 0) stopReason = 'error';

        const event: StreamEvent = {
          type: 'result',
          result: resultText.value,
          stop_reason: stopReason,
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        // Exit code 53 = turn limit — a valid completion, not an error
        if (code !== 0 && code !== 53 && !resultText.value) {
          reject(new Error(stderr || `Gemini exited with code ${code}`));
        } else if (code !== 0 && code !== 53) {
          // Non-zero exit with output (e.g., echoed prompt) — still an error
          reject(new Error(stderr || `Gemini exited with code ${code}`));
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
      case 'message': {
        // Skip user messages (prompt echo) — only collect assistant responses
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
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          this._stats.tokensIn += usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0;
          this._stats.tokensOut += usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0;
          if (usage.cached_tokens) this._stats.cachedTokens += usage.cached_tokens;
          this._updateCost();
          markUsageReceived();
        }
        const content = event.content as string | undefined;
        if (content) resultText.value += content;
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[gemini-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        // Unknown event type — ignore gracefully
        break;
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  /**
   * Get runtime statistics for this session.
   * @returns Stats including message count, token usage, cost, and uptime
   */
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
      contextPercent: 0, // Gemini CLI doesn't expose context usage in headless mode
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
    };
  }

  /**
   * Get the recent message history for this session.
   * @param limit - Maximum number of history items to return (default: DEFAULT_HISTORY_LIMIT)
   * @returns Array of history entries with timestamp, type, and event data
   */
  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  /**
   * Request context compaction — no-op for Gemini since it does not support compaction.
   * @param _summary - Optional summary to use for compaction (ignored)
   * @returns TurnResult indicating compaction is not supported
   */
  async compact(_summary?: string): Promise<TurnResult> {
    const event: StreamEvent = { type: 'result', result: 'Gemini engine does not support compaction' };
    return { text: event.result as string, event };
  }

  /**
   * Get the current effort level for this session.
   * @returns Current effort level
   */
  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  /**
   * Set the effort level for this session.
   * @param level - Effort level (auto, medium, high)
   */
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }

  /**
   * Get accumulated cost for this session.
   * @returns Cost breakdown by category
   */
  getCost(): CostBreakdown {
    const pricing = getModelPricing(this.options.model);
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    return {
      model: this.options.model || 'gemini-2.5-pro',
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

  /**
   * Resolve a model alias to its full model string.
   * @param alias - Model alias (e.g. "gemini-2.5-pro")
   * @returns Resolved model string
   */
  resolveModel(alias: string): string {
    return resolveAlias(alias);
  }

  /**
   * Pause message processing.
   */
  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  /**
   * Resume message processing from paused state.
   */
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  /**
   * Stop the session and terminate the Gemini CLI process.
   */
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
