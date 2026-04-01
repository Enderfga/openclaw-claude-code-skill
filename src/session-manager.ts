/**
 * SessionManager — manages multiple PersistentClaudeSession instances
 *
 * Replaces the Express server layer. Pure class with no HTTP dependency.
 * Can be used by Plugin tools, CLI, or any other consumer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
function getPluginVersion(): string {
  try {
    // Walk up from this file to find package.json
    let dir = path.dirname(_require.resolve('./session-manager.js').replace('/dist/', '/'));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const PERSIST_DIR = path.join(os.homedir(), '.openclaw');
const PERSIST_FILE = path.join(PERSIST_DIR, 'claude-sessions.json');
const PERSIST_DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days on disk

interface PersistedSession {
  name: string;
  claudeSessionId: string;
  cwd: string;
  model?: string;
  originalCreated: string;
  lastResumed: string;
  lastActivity: number;
}

function loadPersistedSessions(): Map<string, PersistedSession> {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return new Map();
    const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
    const arr: PersistedSession[] = JSON.parse(raw);
    const now = Date.now();
    // Filter out entries older than disk TTL
    const valid = arr.filter((s) => now - s.lastActivity < PERSIST_DISK_TTL_MS);
    return new Map(valid.map((s) => [s.name, s]));
  } catch {
    return new Map();
  }
}

// Atomic write: write to .tmp then rename to avoid corrupt reads on crash
function savePersistedSessions(sessions: Map<string, PersistedSession>): void {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const arr = Array.from(sessions.values());
    const tmp = PERSIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, PERSIST_FILE);
  } catch {
    // Best-effort: never crash the manager on write failure
  }
}

// Async version for hot-path (sendMessage, TTL cleanup)
function savePersistedSessionsAsync(sessions: Map<string, PersistedSession>): void {
  const arr = Array.from(sessions.values());
  const tmp = PERSIST_FILE + '.tmp';
  fs.mkdir(PERSIST_DIR, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      console.error('[SessionManager] Failed to create persist dir:', mkdirErr.message);
      return;
    }
    fs.writeFile(tmp, JSON.stringify(arr, null, 2), (writeErr) => {
      if (writeErr) {
        console.error('[SessionManager] Failed to write session file:', writeErr.message);
        return;
      }
      fs.rename(tmp, PERSIST_FILE, (renameErr) => {
        if (renameErr) {
          console.error('[SessionManager] Failed to rename session file:', renameErr.message);
          // Clean up orphan tmp file
          fs.unlink(tmp, () => {});
        }
      });
    });
  });
}

// Debounce helper — coalesces rapid writes into one
function makeDebounced(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

import { PersistentClaudeSession } from './persistent-session.js';
import { PersistentGeminiSession } from './persistent-gemini-session.js';
import { PersistentCodexSession } from './persistent-codex-session.js';
import {
  type SessionConfig,
  type SessionInfo,
  type SendResult,
  type PluginConfig,
  type EffortLevel,
  type EngineType,
  type AgentInfo,
  type SkillInfo,
  type RuleInfo,
  type StreamEvent,
  type ISession,
  type CouncilConfig,
  type CouncilSession,
  type InboxMessage,
  type UltraplanResult,
  type UltrareviewResult,
  MODEL_ALIASES,
  overrideModelPricing,
} from './types.js';
import { Council } from './council.js';

// ─── Internal Types ──────────────────────────────────────────────────────────

interface ManagedSession {
  session: ISession;
  config: SessionConfig;
  created: string;
  lastActivity: number;
  cwd: string;
  claudeSessionId?: string;
}

interface SendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  autoResume?: boolean;
  timeout?: number;
  onEvent?: (event: StreamEvent) => void;
  onChunk?: (chunk: string) => void;
}

// ─── SessionManager ──────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private _pendingSessions = new Map<string, Promise<SessionInfo>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pluginConfig: PluginConfig;
  private persistedSessions: Map<string, PersistedSession>;
  private _debouncedSave: () => void;

  constructor(config?: Partial<PluginConfig>) {
    this.pluginConfig = {
      claudeBin: config?.claudeBin || 'claude',
      defaultModel: config?.defaultModel,
      defaultPermissionMode: config?.defaultPermissionMode || 'acceptEdits',
      defaultEffort: config?.defaultEffort || 'auto',
      maxConcurrentSessions: config?.maxConcurrentSessions || 5,
      sessionTtlMinutes: config?.sessionTtlMinutes || 120,
    };

    // Apply pricing overrides if provided
    if (config?.pricingOverrides) {
      overrideModelPricing(config.pricingOverrides);
    }

    // Load persisted session registry from disk
    this.persistedSessions = loadPersistedSessions();
    // Debounced async writer — at most one write per 5 seconds on hot paths
    this._debouncedSave = makeDebounced(() => savePersistedSessionsAsync(this.persistedSessions), 5000);

    // Start TTL cleanup timer
    this.cleanupTimer = setInterval(() => this._cleanupIdleSessions(), 60_000);
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────────

  async startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo> {
    const name = config.name || `session-${Date.now()}`;

    if (this.sessions.has(name)) {
      const existing = this.sessions.get(name)!;
      return this._toSessionInfo(name, existing);
    }

    // Guard against concurrent creation of the same session name
    const pending = this._pendingSessions.get(name);
    if (pending) return pending;

    const promise = this._doStartSession(name, config);
    this._pendingSessions.set(name, promise);
    try {
      return await promise;
    } finally {
      this._pendingSessions.delete(name);
    }
  }

  private async _doStartSession(
    name: string,
    config: Partial<SessionConfig> & { name?: string },
  ): Promise<SessionInfo> {
    if (this.sessions.size >= this.pluginConfig.maxConcurrentSessions) {
      throw new Error(`Max concurrent sessions (${this.pluginConfig.maxConcurrentSessions}) reached`);
    }

    // Auto-resume: if we have a persisted claudeSessionId for this name, inject it
    const persisted = this.persistedSessions.get(name);
    // Unified: only use resumeSessionId (claudeResumeId is an internal alias, not exposed)
    const resumeId = config.resumeSessionId ?? persisted?.claudeSessionId;

    const fullConfig: SessionConfig = {
      name,
      cwd: config.cwd || persisted?.cwd || process.cwd(),
      permissionMode: config.permissionMode || this.pluginConfig.defaultPermissionMode,
      effort: config.effort || this.pluginConfig.defaultEffort,
      model: config.model || persisted?.model || this.pluginConfig.defaultModel,
      ...config,
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
    };

    // Resolve model alias
    if (fullConfig.model) {
      fullConfig.resolvedModel = this._resolveModel(fullConfig.model, fullConfig.modelOverrides);
    }

    const engine: EngineType = fullConfig.engine || 'claude';
    const session = this._createSession(engine, fullConfig);

    session.on('log', (...args: unknown[]) => console.log(`[Session:${name}]`, ...args));

    await session.start();

    const managed: ManagedSession = {
      session,
      config: fullConfig,
      created: persisted?.originalCreated || new Date().toISOString(),
      lastActivity: Date.now(),
      cwd: fullConfig.cwd,
      claudeSessionId: session.sessionId,
    };

    this.sessions.set(name, managed);

    // Persist registry after session is live
    this._persistSession(name, managed);

    return this._toSessionInfo(name, managed);
  }

  async sendMessage(name: string, message: string, options: SendOptions = {}): Promise<SendResult> {
    const managed = this._getSession(name);
    managed.lastActivity = Date.now();

    const sendOpts: Record<string, unknown> = {
      waitForComplete: true,
      timeout: options.timeout || 300_000,
    };

    if (options.effort) sendOpts.effort = options.effort;
    if (options.plan) sendOpts.plan = true;

    if (options.onEvent || options.onChunk) {
      sendOpts.callbacks = {
        onText: (text: string) => {
          if (options.onChunk) options.onChunk(text);
          if (options.onEvent) options.onEvent({ type: 'text', result: text } as StreamEvent);
        },
        onToolUse: (event: unknown) => {
          if (options.onEvent) options.onEvent({ type: 'tool_use', ...(event as object) } as StreamEvent);
        },
        onToolResult: (event: unknown) => {
          if (options.onEvent) options.onEvent({ type: 'tool_result', ...(event as object) } as StreamEvent);
        },
      };
    }

    const result = await managed.session.send(message, sendOpts);

    // Update session ID if available
    if (managed.session.sessionId) {
      managed.claudeSessionId = managed.session.sessionId;
      this._persistSession(name, managed);
    }

    if ('text' in result) {
      return {
        output: result.text,
        sessionId: managed.claudeSessionId,
        events: [],
      };
    }

    return { output: '', sessionId: managed.claudeSessionId, events: [] };
  }

  async stopSession(name: string): Promise<void> {
    const managed = this._getSession(name);
    managed.session.stop();
    this.sessions.delete(name);
    // Explicit stop = user intent to end session — remove from disk too
    this.persistedSessions.delete(name);
    savePersistedSessions(this.persistedSessions);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.entries()).map(([name, managed]) => this._toSessionInfo(name, managed));
  }

  listPersistedSessions(): PersistedSession[] {
    return Array.from(this.persistedSessions.values());
  }

  getStatus(name: string): SessionInfo & { stats: ReturnType<ISession['getStats']> } {
    const managed = this._getSession(name);
    return {
      ...this._toSessionInfo(name, managed),
      stats: managed.session.getStats(),
    };
  }

  // ─── Session Operations ────────────────────────────────────────────────

  async grepSession(
    name: string,
    pattern: string,
    limit = 50,
  ): Promise<Array<{ time: string; type: string; content: string }>> {
    const managed = this._getSession(name);
    const history = managed.session.getHistory(500);
    const regex = new RegExp(pattern, 'i');
    return history
      .filter((ev) => regex.test(JSON.stringify(ev)))
      .slice(0, limit)
      .map((ev) => ({
        time: ev.time,
        type: ev.type,
        content: JSON.stringify(ev.event),
      }));
  }

  async compactSession(name: string, summary?: string): Promise<void> {
    const managed = this._getSession(name);
    await managed.session.compact(summary);
  }

  setEffort(name: string, level: EffortLevel): void {
    const managed = this._getSession(name);
    managed.session.setEffort(level);
    managed.config.effort = level;
  }

  /**
   * Switch model for a session.
   * Updates in-memory config only (takes effect on next restart/resume).
   * For immediate effect, call restartWithConfig() explicitly.
   */
  setModel(name: string, model: string): void {
    const managed = this._getSession(name);
    const resolved = this._resolveModel(model, managed.config.modelOverrides);
    managed.config.model = model;
    managed.config.resolvedModel = resolved;
  }

  /**
   * Switch model immediately by restarting the session with --resume.
   * Conversation history is preserved via the claude session ID.
   *
   * Guards:
   * - Rejects if session is currently processing a message (busy guard)
   * - Validates model string against known aliases before restarting
   * - Rolls back to old session if startSession fails
   */
  async switchModel(name: string, model: string): Promise<SessionInfo> {
    const managed = this._getSession(name);

    // Busy guard — don't restart mid-message
    if (managed.session.isBusy) {
      throw new Error(
        `Session '${name}' is currently processing a message. Wait for it to finish before switching model.`,
      );
    }

    const sessionId = managed.claudeSessionId || managed.session.sessionId;
    if (!sessionId) throw new Error(`Session '${name}' has no claude session ID — cannot resume after restart`);

    // Validate model — must be a known alias or contain a recognisable pattern
    const resolvedModel = this._resolveModel(model, managed.config.modelOverrides);
    const knownPatterns = ['claude-', 'gemini-', 'gpt-', 'anthropic/', 'google/', 'openai/'];
    const looksValid = knownPatterns.some((p) => resolvedModel.includes(p));
    if (!looksValid) {
      throw new Error(
        `Unknown model '${model}' (resolved: '${resolvedModel}'). Use a known alias (opus, sonnet, haiku, gemini-pro, etc.) or a full provider/model string.`,
      );
    }

    const oldConfig = { ...managed.config };
    managed.session.stop();
    this.sessions.delete(name);

    try {
      return await this.startSession({
        ...oldConfig,
        name,
        model,
        resumeSessionId: sessionId,
      });
    } catch (err) {
      // Rollback: restart with original config
      console.error(`[SessionManager] switchModel failed for '${name}', attempting rollback:`, err);
      try {
        await this.startSession({ ...oldConfig, name, resumeSessionId: sessionId });
      } catch (rollbackErr) {
        console.error(`[SessionManager] Rollback also failed for '${name}':`, rollbackErr);
      }
      throw new Error(`Failed to switch model for '${name}': ${(err as Error).message}`);
    }
  }

  /**
   * Update allowedTools or disallowedTools at runtime.
   *
   * The claude CLI does not support changing tool lists while running, so
   * the only way to apply new constraints is to restart the process with
   * the updated flags and --resume to replay conversation history.
   *
   * Guards:
   * - Rejects if session is busy
   * - Rolls back to old session if startSession fails
   * - merge:true adds tools; removeTools removes specific tools from the list
   */
  async updateTools(
    name: string,
    opts: {
      allowedTools?: string[];
      disallowedTools?: string[];
      removeTools?: string[];
      merge?: boolean;
    },
  ): Promise<SessionInfo> {
    const managed = this._getSession(name);

    // Busy guard
    if (managed.session.isBusy) {
      throw new Error(
        `Session '${name}' is currently processing a message. Wait for it to finish before updating tools.`,
      );
    }

    const sessionId = managed.claudeSessionId || managed.session.sessionId;
    if (!sessionId) throw new Error(`Session '${name}' has no claude session ID — cannot resume after restart`);

    const oldConfig = { ...managed.config };
    let newAllowed = opts.allowedTools;
    let newDisallowed = opts.disallowedTools;

    if (opts.merge) {
      newAllowed = opts.allowedTools
        ? [...new Set([...(oldConfig.allowedTools || []), ...opts.allowedTools])]
        : oldConfig.allowedTools;
      newDisallowed = opts.disallowedTools
        ? [...new Set([...(oldConfig.disallowedTools || []), ...opts.disallowedTools])]
        : oldConfig.disallowedTools;
    }

    // Remove specific tools if requested
    if (opts.removeTools?.length) {
      const removeSet = new Set(opts.removeTools);
      if (newAllowed) newAllowed = newAllowed.filter((t) => !removeSet.has(t));
      if (newDisallowed) newDisallowed = newDisallowed.filter((t) => !removeSet.has(t));
    }

    managed.session.stop();
    this.sessions.delete(name);

    try {
      return await this.startSession({
        ...oldConfig,
        name,
        allowedTools: newAllowed,
        disallowedTools: newDisallowed,
        resumeSessionId: sessionId,
      });
    } catch (err) {
      console.error(`[SessionManager] updateTools failed for '${name}', attempting rollback:`, err);
      try {
        await this.startSession({ ...oldConfig, name, resumeSessionId: sessionId });
      } catch (rollbackErr) {
        console.error(`[SessionManager] Rollback also failed for '${name}':`, rollbackErr);
      }
      throw new Error(`Failed to update tools for '${name}': ${(err as Error).message}`);
    }
  }

  getCost(name: string) {
    const managed = this._getSession(name);
    return managed.session.getCost();
  }

  // ─── Agent/Skill/Rule Management ──────────────────────────────────────

  listAgents(cwd?: string): AgentInfo[] {
    const projectDir = path.join(cwd || os.homedir(), '.claude', 'agents');
    const globalDir = path.join(os.homedir(), '.claude', 'agents');
    const project = this._listMdFiles(projectDir);
    const global = this._listMdFiles(globalDir);
    const seen = new Set(project.map((a) => a.name));
    return [...project, ...global.filter((a) => !seen.has(a.name))];
  }

  createAgent(name: string, cwd?: string, description?: string, prompt?: string): string {
    const dir = path.join(cwd || os.homedir(), '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    const content = `---\ndescription: ${description || name}\n---\n\n${prompt || `You are ${name}.`}\n`;
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  listSkills(cwd?: string): SkillInfo[] {
    const dirs = [path.join(cwd || os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.claude', 'skills')];
    const all: SkillInfo[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        let description = '';
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8');
          const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
          if (match) description = match[1].trim();
        }
        all.push({ name: entry.name, hasSkillMd: fs.existsSync(skillMd), description });
      }
    }
    return all;
  }

  createSkill(name: string, cwd?: string, opts?: { description?: string; prompt?: string; trigger?: string }): string {
    const dir = path.join(cwd || os.homedir(), '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    let content = '---\n';
    if (opts?.description) content += `description: ${opts.description}\n`;
    if (opts?.trigger) content += `trigger: ${opts.trigger}\n`;
    content += `---\n\n${opts?.prompt || `# ${name}\n\nSkill instructions here.\n`}\n`;
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  listRules(cwd?: string): RuleInfo[] {
    const dirs = [path.join(cwd || os.homedir(), '.claude', 'rules'), path.join(os.homedir(), '.claude', 'rules')];
    const all: RuleInfo[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const name = f.replace('.md', '');
        if (seen.has(name)) continue;
        seen.add(name);
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
        const pathsMatch = content.match(/^---\n[\s\S]*?paths:\s*(.+)/m);
        const ifMatch = content.match(/^---\n[\s\S]*?if:\s*(.+)/m);
        all.push({
          name,
          file: f,
          description: descMatch?.[1]?.trim() || '',
          paths: pathsMatch?.[1]?.trim() || '',
          condition: ifMatch?.[1]?.trim() || '',
        });
      }
    }
    return all;
  }

  createRule(
    name: string,
    cwd?: string,
    opts?: { description?: string; content?: string; paths?: string; condition?: string },
  ): string {
    const dir = path.join(cwd || os.homedir(), '.claude', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    let fileContent = '---\n';
    if (opts?.description) fileContent += `description: ${opts.description}\n`;
    if (opts?.paths) fileContent += `paths: ${opts.paths}\n`;
    if (opts?.condition) fileContent += `if: ${opts.condition}\n`;
    fileContent += `---\n\n${opts?.content || `# ${name}\n\nRule instructions here.\n`}\n`;
    fs.writeFileSync(filePath, fileContent);
    return filePath;
  }

  // ─── Agent Teams ───────────────────────────────────────────────────────

  async teamList(name: string): Promise<string> {
    const managed = this._getSession(name);
    const result = await managed.session.send('/team', { waitForComplete: true, timeout: 30_000 });
    return 'text' in result ? result.text : '';
  }

  async teamSend(name: string, teammate: string, message: string): Promise<SendResult> {
    const managed = this._getSession(name);
    managed.lastActivity = Date.now();
    const result = await managed.session.send(`@${teammate} ${message}`, { waitForComplete: true, timeout: 120_000 });
    return {
      output: 'text' in result ? result.text : '',
      sessionId: managed.claudeSessionId,
      events: [],
    };
  }

  // ─── Health ────────────────────────────────────────────────────────────

  /**
   * Returns an overview of all active sessions — analogous to a dashboard.
   * Unlike claude_session_status (single session), this gives the aggregate
   * view: how many sessions are running, which are busy, total uptime, etc.
   */
  health(): {
    ok: boolean;
    version: string;
    sessions: number;
    sessionNames: string[];
    uptime: number;
    details: Array<{
      name: string;
      ready: boolean;
      busy: boolean;
      paused: boolean;
      turns: number;
      costUsd: number;
      contextPercent: number;
      lastActivity: string | null;
    }>;
  } {
    const details = Array.from(this.sessions.entries()).map(([name, managed]) => {
      const stats = managed.session.getStats();
      return {
        name,
        ready: stats.isReady,
        busy: managed.session.isBusy,
        paused: managed.session.isPaused,
        turns: stats.turns,
        costUsd: stats.costUsd,
        contextPercent: stats.contextPercent,
        lastActivity: stats.lastActivity,
      };
    });

    return {
      ok: true,
      version: getPluginVersion(),
      sessions: this.sessions.size,
      sessionNames: Array.from(this.sessions.keys()),
      uptime: process.uptime(),
      details,
    };
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────

  /**
   * Gracefully shut down the session manager.
   *
   * 1. Cancels the periodic TTL cleanup timer
   * 2. Stops all ultrareview polling intervals
   * 3. Sends SIGTERM to all active session child processes
   * 4. Persists final session registry to disk
   *
   * After shutdown(), no new sessions can be started. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Stop ultrareview pollers
    for (const [, timer] of this.ultrareviewPollers) clearInterval(timer);
    this.ultrareviewPollers.clear();
    // Stop all sessions
    for (const [name, managed] of this.sessions) {
      try {
        managed.session.stop();
      } catch {}
      console.log(`[SessionManager] Stopped session: ${name}`);
    }
    this.sessions.clear();
    // Persist final state (TTL-expired sessions already removed by cleanup)
    savePersistedSessions(this.persistedSessions);
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private _persistSession(name: string, managed: ManagedSession): void {
    if (!managed.claudeSessionId) return;
    const existing = this.persistedSessions.get(name);
    this.persistedSessions.set(name, {
      name,
      claudeSessionId: managed.claudeSessionId,
      cwd: managed.cwd,
      model: managed.config.resolvedModel || managed.config.model,
      originalCreated: existing?.originalCreated || managed.created,
      lastResumed: new Date().toISOString(),
      lastActivity: managed.lastActivity,
    });
    this._debouncedSave();
  }

  private _getSession(name: string): ManagedSession {
    const managed = this.sessions.get(name);
    if (!managed) throw new Error(`Session '${name}' not found`);
    return managed;
  }

  private _toSessionInfo(name: string, managed: ManagedSession): SessionInfo {
    const stats = managed.session.getStats();
    return {
      name,
      claudeSessionId: managed.claudeSessionId,
      created: managed.created,
      cwd: managed.cwd,
      model: managed.config.resolvedModel || managed.config.model,
      paused: false,
      stats,
    };
  }

  private _resolveModel(alias: string, overrides?: Record<string, string>): string {
    if (overrides?.[alias]) return overrides[alias];
    if (MODEL_ALIASES[alias]) return MODEL_ALIASES[alias];
    return alias;
  }

  private _listMdFiles(dir: string): AgentInfo[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
        return { name: f.replace('.md', ''), file: f, description: match?.[1]?.trim() || '' };
      });
  }

  private _createSession(engine: EngineType, config: SessionConfig): ISession {
    switch (engine) {
      case 'gemini':
        return new PersistentGeminiSession(config, process.env.GEMINI_BIN);
      case 'codex':
        return new PersistentCodexSession(config, process.env.CODEX_BIN);
      case 'claude':
      default:
        return new PersistentClaudeSession(config, this.pluginConfig.claudeBin);
    }
  }

  // ─── Council ──────────────────────────────────────────────────────────

  private councils = new Map<string, Council>();
  private static COUNCIL_RESULT_TTL_MS = 30 * 60 * 1000; // keep completed councils queryable for 30 min

  councilStart(task: string, config: CouncilConfig): CouncilSession {
    const council = new Council(config, this);
    const initialSession = council.init(task);

    // Store BEFORE running so council_status/abort/inject work while it's active
    this.councils.set(initialSession.id, council);

    // Run in background — callers poll via councilStatus()
    council
      .run()
      .then(() => {
        // Keep completed council queryable; schedule cleanup after TTL
        this._scheduleCouncilCleanup(initialSession.id);
      })
      .catch((err) => {
        console.error(`[SessionManager] Council ${initialSession.id} failed:`, err);
        this._scheduleCouncilCleanup(initialSession.id);
      });

    return initialSession;
  }

  private _scheduleCouncilCleanup(id: string): void {
    setTimeout(() => {
      this.councils.delete(id);
    }, SessionManager.COUNCIL_RESULT_TTL_MS);
  }

  councilStatus(id: string): CouncilSession | undefined {
    const council = this.councils.get(id);
    return council?.getSession();
  }

  councilAbort(id: string): void {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    council.abort();
    this.councils.delete(id);
  }

  councilInject(id: string, message: string): void {
    const council = this.councils.get(id);
    if (!council) throw new Error(`Council '${id}' not found`);
    council.injectMessage(message);
  }

  // ─── Inbox (cross-session messaging) ────────────────────────────────

  private inboxes = new Map<string, InboxMessage[]>();
  private static MAX_INBOX_SIZE = 200;

  private static _escapeXmlAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Send a message from one session to another.
   * If the target is idle, the message is delivered as a user turn.
   * If the target is busy, it's queued in the inbox for later delivery.
   */
  async sessionSendTo(
    from: string,
    to: string,
    message: string,
    summary?: string,
  ): Promise<{ delivered: boolean; queued: boolean }> {
    // Validate both sessions exist
    if (!this.sessions.has(from)) throw new Error(`Sender session '${from}' not found`);
    if (to !== '*' && !this.sessions.has(to)) throw new Error(`Target session '${to}' not found`);

    const inboxMsg: InboxMessage = {
      from,
      text: message,
      timestamp: new Date().toISOString(),
      read: false,
      summary,
    };

    // Broadcast
    if (to === '*') {
      let delivered = 0;
      for (const [name] of this.sessions) {
        if (name === from) continue;
        const ok = await this._deliverOrQueue(name, inboxMsg);
        if (ok) delivered++;
      }
      return { delivered: delivered > 0, queued: delivered === 0 };
    }

    const delivered = await this._deliverOrQueue(to, inboxMsg);
    return { delivered, queued: !delivered };
  }

  private _wrapCrossSessionMessage(msg: InboxMessage): string {
    const esc = SessionManager._escapeXmlAttr;
    const attrs = `from="${esc(msg.from)}"${msg.summary ? ` summary="${esc(msg.summary)}"` : ''}`;
    return `<cross-session-message ${attrs}>\n${msg.text}\n</cross-session-message>`;
  }

  private async _deliverOrQueue(sessionName: string, msg: InboxMessage): Promise<boolean> {
    const managed = this.sessions.get(sessionName);
    if (!managed) return false;

    // If session is idle, deliver directly
    if (!managed.session.isBusy && managed.session.isReady) {
      try {
        await managed.session.send(this._wrapCrossSessionMessage(msg), { waitForComplete: false });
        msg.read = true;
        return true;
      } catch {
        // Fall through to queue
      }
    }

    // Queue in inbox (with size cap — drop oldest read messages first)
    if (!this.inboxes.has(sessionName)) this.inboxes.set(sessionName, []);
    const inbox = this.inboxes.get(sessionName)!;
    if (inbox.length >= SessionManager.MAX_INBOX_SIZE) {
      const readIdx = inbox.findIndex((m) => m.read);
      if (readIdx >= 0) inbox.splice(readIdx, 1);
      else inbox.shift(); // drop oldest unread as last resort
    }
    inbox.push(msg);
    return false;
  }

  /** Read inbox messages for a session */
  sessionInbox(name: string, unreadOnly = true): InboxMessage[] {
    const inbox = this.inboxes.get(name) || [];
    return unreadOnly ? inbox.filter((m) => !m.read) : inbox;
  }

  /** Deliver all queued messages to an idle session, then clear */
  async sessionDeliverInbox(name: string): Promise<number> {
    const managed = this._getSession(name);
    const inbox = this.inboxes.get(name);
    if (!inbox || inbox.length === 0) return 0;

    const unread = inbox.filter((m) => !m.read);
    if (unread.length === 0) return 0;

    // Format all unread messages into one delivery
    const formatted = unread.map((m) => this._wrapCrossSessionMessage(m)).join('\n\n');

    await managed.session.send(formatted, { waitForComplete: false });
    for (const m of unread) m.read = true;
    return unread.length;
  }

  // ─── Ultraplan ────────────────────────────────────────────────────────

  private ultraplans = new Map<string, UltraplanResult>();
  private static ULTRAPLAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
  private static ULTRAPLAN_RESULT_TTL_MS = 30 * 60 * 1000;

  ultraplanStart(task: string, opts?: { model?: string; cwd?: string; timeout?: number }): UltraplanResult {
    const id = `ultraplan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionName = `ultraplan-${id}`;
    const timeout = opts?.timeout || SessionManager.ULTRAPLAN_TIMEOUT_MS;

    const result: UltraplanResult = {
      id,
      status: 'running',
      sessionName,
      startTime: new Date().toISOString(),
    };
    this.ultraplans.set(id, result);

    // Run in background
    this._runUltraplan(id, sessionName, task, opts?.model || 'opus', opts?.cwd || process.cwd(), timeout)
      .catch((err) => {
        result.status = 'error';
        result.error = (err as Error).message;
        result.endTime = new Date().toISOString();
      })
      .finally(() => {
        // Cleanup session
        this.stopSession(sessionName).catch((err) => {
          console.error(`[SessionManager] Failed to stop ultraplan session '${sessionName}':`, err);
        });
        setTimeout(() => this.ultraplans.delete(id), SessionManager.ULTRAPLAN_RESULT_TTL_MS);
      });

    return result;
  }

  private async _runUltraplan(
    id: string,
    sessionName: string,
    task: string,
    model: string,
    cwd: string,
    timeout: number,
  ): Promise<void> {
    const result = this.ultraplans.get(id)!;

    await this.startSession({
      name: sessionName,
      cwd,
      model,
      permissionMode: 'plan',
      effort: 'max',
      appendSystemPrompt:
        'You are in ultraplan mode. Explore the project thoroughly, analyze feasibility, and produce a detailed, actionable plan. Do NOT write code — plan only. Output your final plan in a clear markdown format.',
    });

    const planPrompt = `# Ultraplan Task\n\n${task}\n\nExplore the project, understand the codebase, analyze feasibility, and produce a comprehensive implementation plan. Take your time (up to 30 minutes). Be thorough.`;

    const sendResult = await this.sendMessage(sessionName, planPrompt, { timeout });

    result.plan = sendResult.output;
    result.status = 'completed';
    result.endTime = new Date().toISOString();
  }

  ultraplanStatus(id: string): UltraplanResult | undefined {
    return this.ultraplans.get(id);
  }

  // ─── Ultrareview ──────────────────────────────────────────────────────

  private ultrareviews = new Map<string, UltrareviewResult>();
  private ultrareviewPollers = new Map<string, ReturnType<typeof setInterval>>();
  private static ULTRAREVIEW_RESULT_TTL_MS = 30 * 60 * 1000;

  ultrareviewStart(
    cwd: string,
    opts?: { agentCount?: number; maxDurationMinutes?: number; model?: string; focus?: string },
  ): UltrareviewResult {
    const id = `ultrareview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agentCount = Math.min(20, Math.max(1, opts?.agentCount || 5));

    const result: UltrareviewResult = {
      id,
      status: 'running',
      councilId: '',
      agentCount,
      startTime: new Date().toISOString(),
    };
    this.ultrareviews.set(id, result);

    // Build reviewer agents
    const reviewAngles = [
      {
        name: 'SecurityReviewer',
        emoji: '🔒',
        persona:
          'You are a security expert. Focus on: injection vulnerabilities, auth flaws, data exposure, OWASP top 10, secrets in code.',
      },
      {
        name: 'LogicReviewer',
        emoji: '🧠',
        persona:
          'You are a logic analyst. Focus on: off-by-one errors, race conditions, null/undefined handling, edge cases, incorrect assumptions.',
      },
      {
        name: 'PerformanceReviewer',
        emoji: '⚡',
        persona:
          'You are a performance engineer. Focus on: O(n^2) loops, memory leaks, unnecessary allocations, missing caching, N+1 queries.',
      },
      {
        name: 'APIReviewer',
        emoji: '🔌',
        persona:
          'You are an API design reviewer. Focus on: inconsistent interfaces, missing validation, error handling gaps, backwards compatibility.',
      },
      {
        name: 'TestReviewer',
        emoji: '🧪',
        persona:
          'You are a test coverage analyst. Focus on: untested code paths, missing edge case tests, flaky test patterns, assertion quality.',
      },
      {
        name: 'TypeReviewer',
        emoji: '📐',
        persona:
          'You are a type safety reviewer. Focus on: any casts, unsafe assertions, missing null checks, generic misuse, type narrowing gaps.',
      },
      {
        name: 'ConcurrencyReviewer',
        emoji: '🔀',
        persona:
          'You are a concurrency expert. Focus on: race conditions, deadlocks, shared state mutations, async error handling, promise leaks.',
      },
      {
        name: 'ErrorReviewer',
        emoji: '💥',
        persona:
          'You are an error handling reviewer. Focus on: swallowed errors, missing try/catch, unhelpful error messages, crash-on-startup paths.',
      },
      {
        name: 'DependencyReviewer',
        emoji: '📦',
        persona:
          'You are a dependency auditor. Focus on: outdated packages, known CVEs, unnecessary dependencies, license issues.',
      },
      {
        name: 'ReadabilityReviewer',
        emoji: '📖',
        persona:
          'You are a readability reviewer. Focus on: unclear naming, complex functions, missing context, dead code, confusing control flow.',
      },
      {
        name: 'DataReviewer',
        emoji: '💾',
        persona:
          'You are a data integrity reviewer. Focus on: data validation, schema mismatches, migration issues, encoding problems, data loss paths.',
      },
      {
        name: 'ConfigReviewer',
        emoji: '⚙️',
        persona:
          'You are a configuration reviewer. Focus on: hardcoded values, missing env vars, insecure defaults, missing fallbacks.',
      },
      {
        name: 'ScalabilityReviewer',
        emoji: '📈',
        persona:
          'You are a scalability reviewer. Focus on: single points of failure, stateful bottlenecks, missing pagination, unbounded growth.',
      },
      {
        name: 'DocReviewer',
        emoji: '📝',
        persona:
          'You are a documentation reviewer. Focus on: outdated docs, missing API docs, misleading comments, undocumented behavior.',
      },
      {
        name: 'A11yReviewer',
        emoji: '♿',
        persona:
          'You are an accessibility reviewer. Focus on: missing ARIA labels, keyboard navigation, color contrast, screen reader support.',
      },
      {
        name: 'I18nReviewer',
        emoji: '🌍',
        persona:
          'You are an i18n reviewer. Focus on: hardcoded strings, locale handling, date/number formatting, RTL support.',
      },
      {
        name: 'NetworkReviewer',
        emoji: '🌐',
        persona:
          'You are a network reviewer. Focus on: missing timeouts, retry logic, connection pooling, request size limits.',
      },
      {
        name: 'AuthReviewer',
        emoji: '🔑',
        persona:
          'You are an auth reviewer. Focus on: token handling, session management, CSRF protection, permission checks.',
      },
      {
        name: 'CryptoReviewer',
        emoji: '🔐',
        persona:
          'You are a cryptography reviewer. Focus on: weak algorithms, key management, random number generation, hash collisions.',
      },
      {
        name: 'MemoryReviewer',
        emoji: '🧹',
        persona:
          'You are a memory reviewer. Focus on: memory leaks, circular references, large object retention, stream handling.',
      },
    ];

    const agents = reviewAngles.slice(0, agentCount).map((a) => ({
      ...a,
      model: opts?.model,
    }));

    const maxMinutes = Math.min(25, Math.max(5, opts?.maxDurationMinutes || 10));
    const focus = opts?.focus || 'Find bugs, security issues, and code quality problems';

    const councilConfig: CouncilConfig = {
      name: 'ultrareview',
      agents,
      maxRounds: 2, // Review doesn't need many rounds — find bugs, then synthesize
      projectDir: cwd,
      agentTimeoutMs: maxMinutes * 60 * 1000,
      maxTurnsPerAgent: 20,
    };

    const councilSession = this.councilStart(
      `# Code Review Task\n\nReview the codebase in this project. ${focus}.\n\nEach reviewer: examine the code from your specialty angle, report bugs found with file paths and line numbers. Vote [CONSENSUS: YES] when your review is complete.`,
      councilConfig,
    );

    result.councilId = councilSession.id;

    // Poll council for completion (store ref for shutdown cleanup)
    const pollInterval = setInterval(() => {
      try {
        const status = this.councilStatus(councilSession.id);
        if (!status || status.status === 'running') return;

        clearInterval(pollInterval);
        this.ultrareviewPollers.delete(id);
        result.status = status.status === 'error' ? 'error' : 'completed';
        result.endTime = new Date().toISOString();

        // Synthesize findings from all agent responses
        if (status.responses.length > 0) {
          result.findings = status.responses.map((r) => `## ${r.agent}\n\n${r.content}`).join('\n\n---\n\n');
        }

        setTimeout(() => this.ultrareviews.delete(id), SessionManager.ULTRAREVIEW_RESULT_TTL_MS);
      } catch {
        // Council may have been cleaned up; stop polling
        clearInterval(pollInterval);
        this.ultrareviewPollers.delete(id);
      }
    }, 5000);
    this.ultrareviewPollers.set(id, pollInterval);

    return result;
  }

  ultrareviewStatus(id: string): UltrareviewResult | undefined {
    return this.ultrareviews.get(id);
  }

  private _cleanupIdleSessions(): void {
    const ttlMs = this.pluginConfig.sessionTtlMinutes * 60_000;
    const now = Date.now();
    for (const [name, managed] of this.sessions) {
      if (now - managed.lastActivity > ttlMs) {
        console.log(`[SessionManager] Cleaning up idle in-memory session: ${name}`);
        try {
          managed.session.stop();
        } catch {}
        this.sessions.delete(name);
        // NOTE: do NOT delete from persistedSessions — idle cleanup is
        // in-memory only. Persisted entries survive for PERSIST_DISK_TTL_MS
        // (7 days) so the session can be resumed after a gateway restart.
      }
    }
    // Prune disk entries that exceeded the longer disk TTL
    let pruned = false;
    for (const [name, entry] of this.persistedSessions) {
      if (now - entry.lastActivity > PERSIST_DISK_TTL_MS) {
        this.persistedSessions.delete(name);
        pruned = true;
      }
    }
    if (pruned) savePersistedSessionsAsync(this.persistedSessions);
  }
}
