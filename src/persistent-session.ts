/**
 * Persistent Claude Code Session — wraps `claude` CLI via child_process.spawn
 *
 * Maintains a long-running Claude Code process with streaming JSON I/O.
 * Enables multi-turn agent loops, continuous conversation, and real-time streaming.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';

import {
  type SessionConfig,
  type SessionStats,
  type EffortLevel,
  type HookConfig,
  type StreamEvent,
  MODEL_ALIASES,
  MODEL_PRICING,
  type ModelPricing,
} from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getModelPricing(model?: string): ModelPricing {
  if (!model) return MODEL_PRICING['claude-sonnet-4-6']!;
  const key = model.replace(/^anthropic\/|^google\/|^openai\/|^openai-codex\//g, '');
  return MODEL_PRICING[key] ?? MODEL_PRICING['claude-sonnet-4-6']!;
}

// ─── Send Options ────────────────────────────────────────────────────────────

interface SendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  waitForComplete?: boolean;
  timeout?: number;
  callbacks?: StreamCallbacks;
}

interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolUse?: (event: unknown) => void;
  onToolResult?: (event: unknown) => void;
}

interface TurnResult {
  text: string;
  event: StreamEvent;
}

// ─── Internal Stats ──────────────────────────────────────────────────────────

interface InternalStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  startTime: string | null;
  lastActivity: string | null;
  history: Array<{ time: string; type: string; event: unknown }>;
}

// ─── PersistentClaudeSession ─────────────────────────────────────────────────

export class PersistentClaudeSession extends EventEmitter {
  private options: SessionConfig & { hooks?: HookConfig; modelOverrides?: Record<string, string> };
  private proc: ChildProcess | null = null;
  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  private currentRequestId = 0;
  private _streamCallbacks: StreamCallbacks | null = null;
  private _contextHighFired = false;
  private _realModel: string | null = null;

  public sessionId?: string;
  public stats: InternalStats;

  constructor(config: SessionConfig) {
    super();
    this.options = {
      ...config,
      permissionMode: config.permissionMode || 'acceptEdits',
      hooks: {},
      modelOverrides: config.modelOverrides || {},
    };
    this.stats = {
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      startTime: null,
      lastActivity: null,
      history: [],
    };
  }

  get isReady(): boolean { return this._isReady; }
  get isPaused(): boolean { return this._isPaused; }
  get isBusy(): boolean { return this._isBusy; }

  // ─── Start ───────────────────────────────────────────────────────────────

  /**
   * Resolve the claude binary path.
   * Priority: explicit argument > CLAUDE_BIN env var > 'claude' default.
   */
  private static resolveBin(claudeBin?: string): string {
    return claudeBin || process.env.CLAUDE_BIN || 'claude';
  }

  async start(claudeBin?: string): Promise<this> {
    const resolvedBin = PersistentClaudeSession.resolveBin(claudeBin);
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', this.options.permissionMode || 'acceptEdits',
    ];

    // Model alias resolution
    if (this.options.model) {
      const resolved = this.resolveModel(this.options.model);
      if (resolved !== this.options.model) this.options.model = resolved;
    }

    // Resume / fork
    const resumeId = this.options.claudeResumeId || this.options.resumeSessionId;
    if (resumeId) {
      args.push('--resume', resumeId);
      if (this.options.forkSession) args.push('--fork-session');
    }
    if (this.options.customSessionId) args.push('--session-id', this.options.customSessionId);

    // Model — proxy mode mapping
    if (this.options.model) {
      const CLAUDE_PATTERNS = ['sonnet', 'opus', 'haiku', 'claude-', 'anthropic/', '/claude'];
      const isClaudeModel = CLAUDE_PATTERNS.some(p =>
        this.options.model!.includes(p) || this.options.model!.startsWith(p)
      );
      if (!isClaudeModel && this.options.baseUrl) {
        this._realModel = this.options.model;
        args.push('--model', 'opus');
      } else {
        const cliModel = this.options.model.includes('/') ? this.options.model.split('/').pop()! : this.options.model;
        args.push('--model', cliModel);
      }
    }

    // Tool control
    if (this.options.allowedTools?.length) args.push('--allowed-tools', this.options.allowedTools.join(','));
    if (this.options.disallowedTools?.length) args.push('--disallowed-tools', this.options.disallowedTools.join(','));
    if (this.options.tools) {
      const t = Array.isArray(this.options.tools) ? this.options.tools.join(',') : this.options.tools;
      args.push('--tools', t);
    }

    // System prompts
    if (this.options.systemPrompt) args.push('--system-prompt', this.options.systemPrompt);
    if (this.options.appendSystemPrompt) args.push('--append-system-prompt', this.options.appendSystemPrompt);

    // Limits
    if (this.options.maxTurns) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.maxBudgetUsd) args.push('--max-budget-usd', String(this.options.maxBudgetUsd));

    // Permissions
    if (this.options.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');

    // Agents
    if (this.options.agents) {
      const json = typeof this.options.agents === 'string' ? this.options.agents : JSON.stringify(this.options.agents);
      args.push('--agents', json);
    }
    if (this.options.agent) args.push('--agent', this.options.agent);

    // Directories
    if (this.options.addDir?.length) {
      for (const dir of this.options.addDir) args.push('--add-dir', dir);
    }

    // Effort
    if (this.options.effort && this.options.effort !== 'auto') args.push('--effort', this.options.effort);

    // Auto mode
    if (this.options.enableAutoMode || this.options.permissionMode === 'auto') args.push('--enable-auto-mode');

    // Session name
    if (this.options.sessionName) args.push('-n', this.options.sessionName);

    // New CLI flags
    if (this.options.bare) args.push('--bare');
    if (this.options.worktree) {
      args.push('--worktree');
      if (typeof this.options.worktree === 'string' && this.options.worktree !== 'true') args.push(this.options.worktree);
    }
    if (this.options.fallbackModel) args.push('--fallback-model', this.options.fallbackModel);
    if (this.options.jsonSchema) args.push('--json-schema', this.options.jsonSchema);
    if (this.options.mcpConfig) {
      const configs = Array.isArray(this.options.mcpConfig) ? this.options.mcpConfig : [this.options.mcpConfig];
      for (const c of configs) args.push('--mcp-config', c);
    }
    if (this.options.settings) args.push('--settings', this.options.settings);
    if (this.options.noSessionPersistence) args.push('--no-session-persistence');
    if (this.options.betas) {
      const bl = Array.isArray(this.options.betas) ? this.options.betas : this.options.betas.split(',');
      for (const b of bl) args.push('--betas', b.trim());
    }

    // Ensure CWD exists
    if (this.options.cwd && !fs.existsSync(this.options.cwd)) {
      fs.mkdirSync(this.options.cwd, { recursive: true });
    }

    // Build spawn environment
    // Preserve the parent process PATH so the resolved binary and any PATH-relative
    // tools (git, node, npm, etc.) remain accessible on all platforms and distros.
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    };
    if (this.options.baseUrl) spawnEnv.ANTHROPIC_BASE_URL = this.options.baseUrl;
    if (this.options.enableAgentTeams) spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 'true';
    if (this._realModel && this.options.baseUrl) {
      const base = this.options.baseUrl.replace(/\/$/, '');
      spawnEnv.ANTHROPIC_BASE_URL = `${base}/real/${this._realModel}`;
    }

    // Spawn
    this.proc = spawn(resolvedBin, args, {
      cwd: this.options.cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    // Unref so the parent process can exit independently of the child.
    this.proc.unref();

    // Parse stdout line-by-line
    const rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as StreamEvent;
        this._handleEvent(event);
      } catch {
        this.emit('log', `[stdout] ${line}`);
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.emit('log', `[stderr] ${data.toString()}`);
    });

    this.proc.on('close', (code) => {
      this._isReady = false;
      this.emit('close', code);
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    // Wait for ready
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for session ready')), 30_000);

      this.once('ready', () => { clearTimeout(timeout); resolve(this); });
      this.once('error', (err) => { clearTimeout(timeout); reject(err); });

      // hanging or incorrectly marking a dead process as "ready".
      const onCloseBeforeReady = (code: number | null) => {
        if (!this._isReady) {
          clearTimeout(timeout);
          reject(new Error(`Claude process exited prematurely with code ${code}. Session failed to start.`));
        }
      };
      this.once('close', onCloseBeforeReady);

      // Emit ready on the first `system` init event from the CLI.
      // Fall back to a 2 s timer in case the CLI version doesn't emit one.
      const onInit = () => {
        if (!this._isReady) {
          this._isReady = true;
          // Cleanup the early-close listener since initialization succeeded
          this.removeListener('close', onCloseBeforeReady);
          this.emit('ready');
        }
      };
      this.once('init', onInit);
      setTimeout(() => {
        this.removeListener('init', onInit);
        // If it was killed or has an exitCode, we reject the promise to prevent
        if (this.proc?.killed || this.proc?.exitCode !== null) {
          clearTimeout(timeout);
          this.removeListener('close', onCloseBeforeReady);
          reject(new Error("Claude CLI process crashed immediately upon startup. Fallback timer aborted."));
          return;
        }
        if (!this._isReady) {
          this._isReady = true;
          this.emit('ready');
        }
      }, 2000);
    });
  }

  // ─── Event Handling ──────────────────────────────────────────────────────

  private _handleEvent(event: StreamEvent): void {
    const type = event.type;
    this.stats.lastActivity = new Date().toISOString();

    // Track history (keep last 100)
    this.stats.history.push({ time: this.stats.lastActivity, type, event });
    if (this.stats.history.length > 100) this.stats.history.shift();

    switch (type) {
      case 'system':
        if (event.subtype === 'init') {
          this.sessionId = event.session_id;
          this.stats.startTime = new Date().toISOString();
          this.emit('init', event);
        }
        this.emit('system', event);
        break;

      case 'stream_event': {
        const inner = (event as Record<string, unknown>).event as Record<string, unknown> | undefined;
        if (!inner) break;
        const innerType = inner.type as string;

        if (innerType === 'content_block_start') {
          const block = (inner as Record<string, unknown>).content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use') {
            this.stats.toolCalls++;
            const toolEvent = { tool: { name: block.name, input: {} } };
            try { this._streamCallbacks?.onToolUse?.(toolEvent); } catch {}
            this.emit('tool_use', toolEvent);
          }
        } else if (innerType === 'content_block_delta') {
          const delta = (inner as Record<string, unknown>).delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            try { this._streamCallbacks?.onText?.(delta.text as string); } catch {}
            this.emit('text', delta.text);
          }
        } else if (innerType === 'message_delta') {
          const usage = (inner as Record<string, unknown>).usage as Record<string, number> | undefined;
          if (usage) {
            this.stats.tokensIn += usage.input_tokens || 0;
            this.stats.tokensOut += usage.output_tokens || 0;
            this.stats.cachedTokens += usage.cache_read_input_tokens || 0;
            this._updateCost();
          }
        }
        this.emit('stream_event', event);
        break;
      }

      case 'user':
        this.stats.turns++;
        this.emit('user_echo', event);
        break;

      case 'assistant':
        this.emit('assistant', event);
        if (event.message?.content && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              this.stats.toolCalls++;
              const toolEvent = { tool: { name: (block as Record<string, unknown>).name, input: (block as Record<string, unknown>).input || {} } };
              try { this._streamCallbacks?.onToolUse?.(toolEvent); } catch {}
              this.emit('tool_use', toolEvent);
            }
          }
        }
        break;

      case 'tool_use':
        this.stats.toolCalls++;
        try { this._streamCallbacks?.onToolUse?.(event); } catch {}
        this.emit('tool_use', event);
        break;

      case 'tool_result':
        try { this._streamCallbacks?.onToolResult?.(event); } catch {}
        if ((event as Record<string, unknown>).is_error || (event as Record<string, unknown>).error) {
          this.stats.toolErrors++;
          this._fireHook('onToolError', { tool: (event as Record<string, unknown>).tool_use_id, error: (event as Record<string, unknown>).error });
        }
        this.emit('tool_result', event);
        break;

      case 'error':
        this.emit('error', new Error(String((event as Record<string, unknown>).error) || JSON.stringify(event)));
        break;

      case 'result': {
        const usage = (event as Record<string, unknown>).usage as Record<string, number> | undefined;
        if (usage) {
          this.stats.tokensIn += usage.input_tokens || 0;
          this.stats.tokensOut += usage.output_tokens || 0;
          this.stats.cachedTokens += usage.cache_read_input_tokens || 0;
          this._updateCost();
        }
        this.emit('result', event);
        this.emit('turn_complete', event);
        this._fireHook('onTurnComplete', { text: event.result, usage, stopReason: (event as Record<string, unknown>).stop_reason });

        const totalTokens = this.stats.tokensIn + this.stats.tokensOut;
        if (totalTokens > 140_000 && !this._contextHighFired) {
          this._contextHighFired = true;
          this._fireHook('onContextHigh', { tokensUsed: totalTokens, threshold: 140_000 });
        }
        const stopReason = (event as Record<string, unknown>).stop_reason;
        if (stopReason === 'error' || stopReason === 'rate_limit') {
          this._fireHook('onStopFailure', { reason: stopReason, error: (event as Record<string, unknown>).error });
        }
        break;
      }

      default:
        this.emit('event', event);
    }
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  async send(message: string | unknown[], options: SendOptions = {}): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady || !this.proc) throw new Error('Session not ready. Call start() first.');

    const requestId = ++this.currentRequestId;

    let finalMessage = typeof message === 'string' ? message : message;
    if (typeof finalMessage === 'string') {
      if (options.effort === 'high' || options.effort === 'max') {
        finalMessage = `ultrathink\n\n${finalMessage}`;
      }
      if (options.plan) {
        finalMessage = `/plan ${finalMessage}`;
      }
    }

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: typeof finalMessage === 'string'
          ? [{ type: 'text', text: finalMessage }]
          : finalMessage,
      },
    };

    this.proc.stdin!.write(JSON.stringify(payload) + '\n');

    if (options.callbacks) this._streamCallbacks = options.callbacks;

    if (options.waitForComplete) {
      this._isBusy = true;
      try {
        return await this._waitForTurnComplete(options.timeout || 300_000);
      } finally {
        this._isBusy = false;
        if (options.callbacks) this._streamCallbacks = null;
      }
    }

    return { requestId, sent: true };
  }

  // ─── Wait for Turn Complete ──────────────────────────────────────────────

  private _waitForTurnComplete(timeout: number): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let streamedText = '';
      let allAssistantText = '';
      const toolNames: string[] = [];

      const onText = (chunk: string) => { streamedText += chunk; };
      this.on('text', onText);

      const onAssistant = (event: StreamEvent) => {
        if (event.message?.content && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) allAssistantText += block.text + '\n';
          }
        }
      };
      this.on('assistant', onAssistant);

      const onToolUse = (event: Record<string, unknown>) => {
        const tool = event.tool as Record<string, string> | undefined;
        toolNames.push(tool?.name || event.name as string || 'unknown');
      };
      this.on('tool_use', onToolUse);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('text', onText);
        this.removeListener('assistant', onAssistant);
        this.removeListener('tool_use', onToolUse);
        this.removeListener('turn_complete', onTurnComplete);
        this.removeListener('error', onError);
        this.removeListener('close', onClose);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Timeout waiting for response'));
      }, timeout);

      const onTurnComplete = (event: StreamEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        let text = (event as Record<string, unknown>).result as string || streamedText || allAssistantText.trim() || '';
        if (!text && toolNames.length > 0) {
          const unique = [...new Set(toolNames)];
          text = `[Agent completed ${toolNames.length} tool calls: ${unique.join(', ')}]`;
        }
        resolve({ text, event });
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onClose = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        const text = streamedText || allAssistantText.trim() || '';
        resolve({
          text,
          event: { type: 'result', result: text, stop_reason: 'process_exit', exit_code: code } as unknown as StreamEvent,
        });
      };

      this.once('turn_complete', onTurnComplete);
      this.once('error', onError);
      this.once('close', onClose);
    });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: this.stats.turns,
      toolCalls: this.stats.toolCalls,
      toolErrors: this.stats.toolErrors,
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      cachedTokens: this.stats.cachedTokens,
      costUsd: Math.round(this.stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this.stats.startTime,
      lastActivity: this.stats.lastActivity,
      // Approximate: assumes a 200k-token context window.
      // Claude Code doesn't expose exact context usage via the JSON protocol,
      // so this is a best-effort estimate based on cumulative token counts.
      contextPercent: Math.min(100, Math.round(
        (this.stats.tokensIn + this.stats.tokensOut) / 200_000 * 100
      )),
      sessionId: this.sessionId,
      uptime: this.stats.startTime
        ? Math.round((Date.now() - new Date(this.stats.startTime).getTime()) / 1000)
        : 0,
    };
  }

  getHistory(limit = 50): Array<{ time: string; type: string; event: unknown }> {
    return this.stats.history.slice(-limit);
  }

  async compact(summary?: string): Promise<TurnResult | { requestId: number; sent: boolean }> {
    const msg = summary ? `/compact ${summary}` : '/compact';
    return this.send(msg, { waitForComplete: true, timeout: 60_000 });
  }

  getEffort(): EffortLevel { return this.options.effort || 'auto'; }
  setEffort(level: EffortLevel): void { this.options.effort = level; }

  getCost() {
    const pricing = getModelPricing(this.options.model);
    const nonCachedIn = Math.max(0, this.stats.tokensIn - this.stats.cachedTokens);
    return {
      model: this.options.model || 'default',
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      cachedTokens: this.stats.cachedTokens,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: pricing.cached },
      breakdown: {
        inputCost: (nonCachedIn / 1_000_000) * pricing.input,
        cachedCost: (this.stats.cachedTokens / 1_000_000) * (pricing.cached ?? 0),
        outputCost: (this.stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this.stats.costUsd,
    };
  }

  resolveModel(alias: string): string {
    if (this.options.modelOverrides?.[alias]) return this.options.modelOverrides[alias];
    if (MODEL_ALIASES[alias]) return MODEL_ALIASES[alias];
    return alias;
  }

  pause(): void { this._isPaused = true; this.emit('paused', { sessionId: this.sessionId }); }
  resume(): void { this._isPaused = false; this.emit('resumed', { sessionId: this.sessionId }); }

  stop(): void {
    this._fireHook('onStop', { cost: this.getCost(), stats: this.getStats() });
    if (this.proc) {
      const pid = this.proc.pid!;
      this.proc.stdin?.end();
      try { process.kill(-pid, 'SIGTERM'); } catch {
        try { this.proc.kill('SIGTERM'); } catch {}
      }
      const p = this.proc;
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try { p.kill('SIGKILL'); } catch {}
      }, 3000);
      this.proc = null;
    }
    this._isReady = false;
    this._isPaused = false;
    this.emit('close', 143);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _updateCost(): void {
    const pricing = getModelPricing(this.options.model);
    const nonCachedIn = Math.max(0, this.stats.tokensIn - this.stats.cachedTokens);
    this.stats.costUsd =
      (nonCachedIn / 1_000_000) * pricing.input +
      (this.stats.cachedTokens / 1_000_000) * (pricing.cached ?? 0) +
      (this.stats.tokensOut / 1_000_000) * pricing.output;
  }

  private _fireHook(hookName: string, data: unknown): void {
    const hooks = this.options.hooks as Record<string, unknown> | undefined;
    const hook = hooks?.[hookName];
    if (typeof hook === 'function') {
      try { (hook as (d: unknown) => void)(data); } catch {}
    }
    this.emit(`hook:${hookName}`, data);
  }
}
