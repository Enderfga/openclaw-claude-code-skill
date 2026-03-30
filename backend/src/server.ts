/**
 * claude-code-backend — Backend API server for claude-code-skill
 *
 * Architecture:
 *   claude-code-skill CLI  ─HTTP→  this server (:18795)
 *       ↓
 *   Claude Code CLI (driven via -p / --print + stream-json OR mcp serve)
 *
 * Persistent sessions are managed in-process using child_process.spawn.
 * Each session maps a friendly name → an active Claude Code process
 * communicating via stdin/stdout in stream-json format.
 *
 * MCP (direct tool calls) go through `claude mcp serve` (stdio).
 */

import express, { Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';

const PORT = parseInt(process.env.BACKEND_API_PORT || '18795', 10);
const PREFIX = '/backend-api/claude-code';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// API key forwarded to the Claude Code CLI process (ANTHROPIC_API_KEY or equivalent)
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  isReady: boolean;
  lastActivity: string;
  contextPercent: number;
}

interface HookConfig {
  onToolError?: string;
  onContextHigh?: string;
  onStop?: string;
  onTurnComplete?: string;
  onStopFailure?: string;
}

type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan' | 'auto';
type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'auto';

interface SessionConfig {
  name: string;
  sessionName?: string;
  cwd: string;
  model?: string;
  baseUrl?: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
  agents?: Record<string, { description?: string; prompt: string }>;
  agent?: string;
  customSessionId?: string;
  addDir?: string[];
  effort?: EffortLevel;
  modelOverrides?: Record<string, string>;
  enableAutoMode?: boolean;
  forkSession?: boolean;
  // resume from existing claude session
  claudeResumeId?: string;
  resolvedModel?: string;
  // New CLI flags
  bare?: boolean;
  worktree?: string | boolean;
  fallbackModel?: string;
  jsonSchema?: string;
  mcpConfig?: string | string[];
  settings?: string;
  noSessionPersistence?: boolean;
  betas?: string | string[];
  enableAgentTeams?: boolean;
}

interface ActiveSession {
  config: SessionConfig;
  claudeSessionId?: string;
  created: string;
  stats: SessionStats;
  hooks: HookConfig;
  paused: boolean;
  // For interactive (non-print) sessions we keep a persistent process
  proc?: ChildProcess;
  // Buffer for streaming reads
  outputBuffer: string;
  pendingResolvers: Array<(text: string) => void>;
  // turn lock — only one message at a time
  busy: boolean;
  // effort can be overridden per-session after start
  currentEffort?: EffortLevel;
  // model aliases
  resolvedModel?: string;
}

// ─── Model Aliases ────────────────────────────────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  opus:         'claude-opus-4-6',
  sonnet:       'claude-sonnet-4-6',
  haiku:        'claude-haiku-4-5',
  'gemini-flash': 'gemini-2.0-flash',
  'gemini-pro': 'gemini-1.5-pro',
};

function resolveModel(model: string, overrides?: Record<string, string>): string {
  if (overrides && model in overrides) return overrides[model];
  if (model in MODEL_ALIASES) return MODEL_ALIASES[model];
  return model;
}

// ─── Pricing DB ──────────────────────────────────────────────────────────────

interface ModelPricing { inputPer1M: number; outputPer1M: number; cachedPer1M: number }

const PRICING_DB: Record<string, ModelPricing> = {
  'claude-opus-4-6':    { inputPer1M: 15,    outputPer1M: 75,   cachedPer1M: 1.875 },
  'claude-sonnet-4-6':  { inputPer1M: 3,     outputPer1M: 15,   cachedPer1M: 0.3   },
  'claude-haiku-4-5':   { inputPer1M: 0.8,   outputPer1M: 4,    cachedPer1M: 0.08  },
  'gemini-2.0-flash':   { inputPer1M: 0.075, outputPer1M: 0.3,  cachedPer1M: 0.01875 },
  'gemini-1.5-pro':     { inputPer1M: 1.25,  outputPer1M: 5,    cachedPer1M: 0.3125 },
  'gpt-4o':             { inputPer1M: 2.5,   outputPer1M: 10,   cachedPer1M: 1.25  },
  'gpt-5.4':            { inputPer1M: 2.5,   outputPer1M: 10,   cachedPer1M: 1.25  },
  // fallback
  default:              { inputPer1M: 3,     outputPer1M: 15,   cachedPer1M: 0.3   },
};

function getPricing(model?: string): ModelPricing {
  if (!model) return PRICING_DB.default;
  for (const [key, pricing] of Object.entries(PRICING_DB)) {
    if (model.toLowerCase().includes(key)) return pricing;
  }
  return PRICING_DB.default;
}

// ─── Session Store ────────────────────────────────────────────────────────────

const sessions = new Map<string, ActiveSession>();

function getSession(name: string): ActiveSession | undefined {
  return sessions.get(name);
}

// ─── Session TTL cleanup ──────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle → auto-remove

setInterval(() => {
  const now = Date.now();
  for (const [name, session] of sessions) {
    const lastActive = new Date(session.stats.lastActivity).getTime();
    if (now - lastActive > SESSION_TTL_MS) {
      if (session.hooks.onStop) {
        fireWebhook(session.hooks.onStop, { hook: 'onStop', session: name, data: { reason: 'ttl', stats: session.stats }, timestamp: new Date().toISOString() });
      }
      sessions.delete(name);
    }
  }
}, 60_000); // check every minute

// ─── Build claude CLI args ──────────────────────────────────────────────────

function buildPrintArgs(
  prompt: string,
  config: SessionConfig,
  resumeId?: string,
  effort?: EffortLevel,
  plan?: boolean,
): string[] {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];

  // Permission mode
  if (config.permissionMode === 'auto') {
    args.push('--permission-mode', 'auto');
  } else if (config.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else if (config.permissionMode && config.permissionMode !== 'default') {
    args.push('--permission-mode', config.permissionMode);
  }

  // Tools
  if (config.allowedTools?.length) {
    args.push('--allowedTools', config.allowedTools.join(','));
  }
  if (config.disallowedTools?.length) {
    args.push('--disallowedTools', config.disallowedTools.join(','));
  }

  // Model
  const model = config.resolvedModel || config.model;
  if (model) args.push('--model', model);

  // Budget
  if (config.maxBudgetUsd) args.push('--max-budget-usd', String(config.maxBudgetUsd));

  // System prompt
  if (config.systemPrompt) args.push('--system-prompt', config.systemPrompt);
  if (config.appendSystemPrompt) args.push('--append-system-prompt', config.appendSystemPrompt);

  // Add dirs
  if (config.addDir?.length) {
    args.push('--add-dir', ...config.addDir);
  }

  // Agents
  if (config.agents) {
    args.push('--agents', JSON.stringify(config.agents));
  }
  if (config.agent) {
    args.push('--agent', config.agent);
  }

  // Effort — use native CLI flag
  const effectiveEffort = effort || config.effort;
  if (effectiveEffort && effectiveEffort !== 'auto') {
    args.push('--effort', effectiveEffort);
  }

  // Plan mode
  if (plan) {
    args.push('--append-system-prompt',
      'IMPORTANT: Before doing anything, write a numbered execution plan. ' +
      'After the user confirms or says proceed, execute it step by step.');
  }

  // Resume
  if (resumeId) {
    args.push('--resume', resumeId);
  }

  // Session ID
  if (config.customSessionId) {
    args.push('--session-id', config.customSessionId);
  }

  // New CLI flags
  if (config.bare) args.push('--bare');
  if (config.worktree) {
    args.push('--worktree');
    if (typeof config.worktree === 'string') args.push(config.worktree);
  }
  if (config.fallbackModel) args.push('--fallback-model', config.fallbackModel);
  if (config.jsonSchema) args.push('--json-schema', config.jsonSchema);
  if (config.mcpConfig) {
    const configs = Array.isArray(config.mcpConfig) ? config.mcpConfig : [config.mcpConfig];
    for (const c of configs) args.push('--mcp-config', c);
  }
  if (config.settings) args.push('--settings', config.settings);
  if (config.noSessionPersistence) args.push('--no-session-persistence');
  if (config.betas) {
    const bl = Array.isArray(config.betas) ? config.betas : [config.betas];
    for (const b of bl) args.push('--betas', b);
  }

  // Prompt is now passed via stdin to avoid OS ARG_MAX limits on long prompts

  return args;
}

function buildExtraEnv(config: SessionConfig): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (config.enableAgentTeams) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 'true';
  }
  if (config.baseUrl) {
    env.ANTHROPIC_BASE_URL = config.baseUrl;
  }
  return Object.keys(env).length ? env : undefined;
}

// ─── Run claude -p (stream-json) ──────────────────────────────────────────────

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  [key: string]: unknown;
}

async function runClaude(
  args: string[],
  cwd: string,
  onEvent?: (ev: StreamEvent) => void,
  extraEnv?: Record<string, string>,
): Promise<{ output: string; sessionId?: string; error?: string; events: StreamEvent[] }> {

  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: API_KEY,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...extraEnv,
    };

    const proc = spawn(CLAUDE_BIN, args, { 
      cwd, 
      env,
      stdio: ['pipe', 'pipe', 'pipe'] 
    });

    // Write prompt to stdin to handle arbitrarily long prompts
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    const events: StreamEvent[] = [];
    let sessionId: string | undefined;
    let outputText = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const raw = chunk.toString();
      stdout += raw;
      // Parse NDJSON lines
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev: StreamEvent = JSON.parse(trimmed);
          events.push(ev);
          if (onEvent) onEvent(ev);

          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            sessionId = ev.session_id as string;
          }
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const c of ev.message.content) {
              if (c.type === 'text' && c.text) outputText += c.text;
            }
          }
          if (ev.type === 'result' && ev.result) {
            outputText = ev.result as string;
          }
        } catch {
          // not JSON, raw text
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 && !outputText) {
        resolve({ output: '', sessionId, error: stderr || `Exit code ${code}`, events });
      } else {
        resolve({ output: outputText, sessionId, events });
      }
    });

    proc.on('error', (err) => {
      resolve({ output: '', sessionId, error: err.message, events });
    });
  });
}

// ─── Session history via claude session files ─────────────────────

function getClaudeSessionHistory(claudeSessionId: string, limit = 20): unknown[] {
  try {
    const sessionFile = path.join(SESSIONS_DIR, `${claudeSessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) return [];
    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return events.slice(-limit);
  } catch {
    return [];
  }
}

// List all session files for `sessions` endpoint
function listAllClaudeSessions(limit = 20): unknown[] {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(SESSIONS_DIR, f);
        const stat = fs.statSync(full);
        const id = f.replace('.jsonl', '');
        // Read first few lines to get summary/project
        const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).slice(0, 5);
        let projectPath: string | undefined;
        let summary: string | undefined;
        for (const l of lines) {
          try {
            const ev = JSON.parse(l);
            if (ev.cwd) projectPath = ev.cwd;
            if (ev.type === 'system' && ev.subtype === 'init' && ev.cwd) projectPath = ev.cwd;
          } catch {}
        }
        return {
          sessionId: id,
          projectPath,
          summary,
          modified: stat.mtime.toISOString(),
          messageCount: lines.length,
        };
      })
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
      .slice(0, limit);
    return files;
  } catch {
    return [];
  }
}

// ─── Webhook helper ──────────────────────────────────────────────────────────

async function fireWebhook(url: string, payload: object): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── MCP: connect / disconnect / tools / direct calls ────────────────────────
// We use `claude mcp serve` (stdio MCP server) for direct tool calls.
// For simplicity we spawn a fresh process per call — stateless.

let mcpConnected = false;

app.post(`${PREFIX}/connect`, (_req, res) => {
  mcpConnected = true;
  res.json({ ok: true, status: 'connected', server: { name: 'claude' }, tools: 20 });
});

app.post(`${PREFIX}/disconnect`, (_req, res) => {
  mcpConnected = false;
  res.json({ ok: true });
});

app.get(`${PREFIX}/tools`, (_req, res) => {
  if (!mcpConnected) {
    res.json({ ok: false, error: 'Not connected. Run connect first.' });
    return;
  }
  // Return known tool set (matches what stream-json init event reports)
  const tools = [
    'Task','Bash','Edit','Glob','Grep',
    'Read','Write','WebFetch','WebSearch','TodoWrite',
    'NotebookEdit','EnterPlanMode','ExitPlanMode',
    'EnterWorktree','ExitWorktree','CronCreate','CronDelete','CronList',
    'TaskStop','Skill',
  ].map(name => ({ name, description: `Claude Code built-in: ${name}` }));
  res.json({ ok: true, tools });
});

// Generic direct tool call via -p
async function directToolCall(tool: string, args: Record<string, unknown>, cwd = '/tmp'): Promise<unknown> {
  const prompt = `Call tool ${tool} with these args and output only the result as JSON:\n${JSON.stringify(args, null, 2)}`;
  const result = await runClaude(
    ['-p', '--output-format', 'json', '--dangerously-skip-permissions', prompt],
    cwd
  );
  if (result.error) throw new Error(result.error);
  return result.output;
}

app.post(`${PREFIX}/bash`, async (req: Request, res: Response) => {
  const { command, description, cwd } = req.body as { command: string; description?: string; cwd?: string };
  try {
    const result = await runClaude(
      ['-p', '--output-format', 'json', '--dangerously-skip-permissions',
       `Run this bash command and return stdout/stderr as JSON with keys stdout and stderr:\n${command}`],
      cwd || '/tmp'
    );
    res.json({ ok: true, result: { stdout: result.output, stderr: '' } });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
});

app.post(`${PREFIX}/read`, async (req: Request, res: Response) => {
  const { file_path } = req.body as { file_path: string };
  try {
    const content = fs.readFileSync(file_path, 'utf8');
    res.json({ ok: true, result: { type: 'file', file: { content } } });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
});

app.post(`${PREFIX}/call`, async (req: Request, res: Response) => {
  const { tool, args, cwd } = req.body as { tool: string; args: Record<string, unknown>; cwd?: string };
  try {
    const result = await directToolCall(tool, args, cwd || '/tmp');
    res.json({ ok: true, result });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
});

app.post(`${PREFIX}/batch-read`, async (req: Request, res: Response) => {
  const { patterns, basePath } = req.body as { patterns: string[]; basePath?: string };
  const base = basePath || '/tmp';
  const files: Array<{ path: string; content: string; error?: string }> = [];
  for (const pattern of patterns) {
    try {
      // Simple glob via find
      const { execSync } = await import('child_process');
      const safePattern = pattern.replace(/[^a-zA-Z0-9_.*?\-\/]/g, '');
      const found = execSync(`find ${JSON.stringify(base)} -name ${JSON.stringify(safePattern)} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
      for (const f of found) {
        try { files.push({ path: f, content: fs.readFileSync(f, 'utf8') }); }
        catch (e) { files.push({ path: f, content: '', error: (e as Error).message }); }
      }
    } catch (e) {
      files.push({ path: pattern, content: '', error: (e as Error).message });
    }
  }
  res.json({ ok: true, files });
});

// ─── Session history endpoint (all claude sessions) ──────────────────────────

app.get(`${PREFIX}/sessions`, (_req, res) => {
  const limit = parseInt((_req.query.limit as string) || '20', 10);
  res.json({ ok: true, sessions: listAllClaudeSessions(limit) });
});

app.post(`${PREFIX}/resume`, async (req: Request, res: Response) => {
  const { sessionId, prompt, cwd } = req.body as { sessionId: string; prompt: string; cwd?: string };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--resume', sessionId, '--dangerously-skip-permissions', prompt];
  const result = await runClaude(args, cwd || '/tmp');
  if (result.error) { res.json({ ok: false, error: result.error }); return; }
  res.json({ ok: true, output: result.output, stderr: '' });
});

app.post(`${PREFIX}/continue`, async (req: Request, res: Response) => {
  const { prompt, cwd } = req.body as { prompt: string; cwd?: string };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--continue', '--dangerously-skip-permissions', prompt];
  const result = await runClaude(args, cwd || '/tmp');
  if (result.error) { res.json({ ok: false, error: result.error }); return; }
  res.json({ ok: true, output: result.output });
});

// ─── Persistent Sessions ──────────────────────────────────────────────────────

app.post(`${PREFIX}/session/start`, async (req: Request, res: Response) => {
  const body = req.body as SessionConfig & { sessionId?: string };

  // sessionId in body means resume existing claude session
  const name = body.name || `session-${Date.now()}`;
  if (sessions.has(name)) {
    const existing = sessions.get(name)!;
    res.json({ ok: true, claudeSessionId: existing.claudeSessionId, alreadyExists: true });
    return;
  }

  const config: SessionConfig = {
    name,
    sessionName: body.sessionName,
    cwd: body.cwd || process.cwd(),
    model: body.model,
    baseUrl: body.baseUrl,
    permissionMode: body.permissionMode || 'acceptEdits',
    allowedTools: body.allowedTools,
    disallowedTools: body.disallowedTools,
    tools: body.tools,
    maxTurns: body.maxTurns,
    maxBudgetUsd: body.maxBudgetUsd,
    systemPrompt: body.systemPrompt,
    appendSystemPrompt: body.appendSystemPrompt,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions,
    agents: body.agents,
    agent: body.agent,
    customSessionId: body.customSessionId,
    addDir: body.addDir,
    effort: body.effort,
    modelOverrides: body.modelOverrides,
    enableAutoMode: body.enableAutoMode,
    forkSession: body.forkSession,
    claudeResumeId: body.sessionId, // resume from existing claude session
    // New CLI flags
    bare: body.bare,
    worktree: body.worktree,
    fallbackModel: body.fallbackModel,
    jsonSchema: body.jsonSchema,
    mcpConfig: body.mcpConfig,
    settings: body.settings,
    noSessionPersistence: body.noSessionPersistence,
    betas: body.betas,
    enableAgentTeams: body.enableAgentTeams,
  };

  if (config.model) {
    config.resolvedModel = resolveModel(config.model, config.modelOverrides);
  }

  const session: ActiveSession = {
    config,
    created: new Date().toISOString(),
    stats: { turns: 0, toolCalls: 0, toolErrors: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0, isReady: true, lastActivity: new Date().toISOString(), contextPercent: 0 },
    hooks: {},
    paused: false,
    outputBuffer: '',
    pendingResolvers: [],
    busy: false,
  };

  sessions.set(name, session);

  // If resuming, do a quick probe to get the claudeSessionId
  if (config.claudeResumeId) {
    session.claudeSessionId = config.claudeResumeId;
  }

  res.json({ ok: true, claudeSessionId: session.claudeSessionId });
});

// ─── Session send (non-streaming) ────────────────────────────────────────────

app.post(`${PREFIX}/session/send`, async (req: Request, res: Response) => {
  const { name, message, timeout: timeoutMs = 600_000, effort, plan, autoResume } = req.body as {
    name: string; message: string; timeout?: number;
    effort?: EffortLevel; plan?: boolean; autoResume?: boolean;
  };

  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }
  if (session.paused) { res.json({ ok: false, error: `Session '${name}' is paused` }); return; }

  session.stats.lastActivity = new Date().toISOString();

  const args = buildPrintArgs(
    message, session.config,
    session.claudeSessionId,
    effort || session.currentEffort,
    plan,
  );

  // Inject forkSession on next send after start if configured
  if (session.config.forkSession && session.claudeSessionId && !session.stats.turns) {
    args.splice(args.indexOf('--resume') + 2, 0, '--fork-session');
  }

  const result = await runClaude(args, session.config.cwd, (ev) => {
    // Track stats from stream events
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      session.claudeSessionId = ev.session_id as string;
    }
    if (ev.type === 'assistant' && ev.message?.usage) {
      const u = ev.message.usage;
      session.stats.tokensIn += u.input_tokens || 0;
      session.stats.tokensOut += u.output_tokens || 0;
      session.stats.cachedTokens += u.cache_read_input_tokens || 0;
    }
    if (ev.type === 'tool_use') {
      session.stats.toolCalls++;
    }
    if (ev.type === 'tool_result' && ev.is_error) {
      session.stats.toolErrors++;
      if (session.hooks.onToolError) {
        fireWebhook(session.hooks.onToolError, { hook: 'onToolError', session: name, data: ev, timestamp: new Date().toISOString() });
      }
    }
  }, buildExtraEnv(session.config));

  session.stats.turns++;

  if (session.hooks.onTurnComplete) {
    fireWebhook(session.hooks.onTurnComplete, {
      hook: 'onTurnComplete', session: name,
      data: { tokensIn: session.stats.tokensIn, tokensOut: session.stats.tokensOut },
      timestamp: new Date().toISOString(),
    });
  }

  if (result.error) {
    if (session.hooks.onStopFailure) {
      fireWebhook(session.hooks.onStopFailure, { hook: 'onStopFailure', session: name, data: { error: result.error }, timestamp: new Date().toISOString() });
    }
    // autoResume: retry once without resume id
    if (autoResume) {
      const retryArgs = buildPrintArgs(message, { ...session.config, claudeResumeId: undefined }, undefined, effort, plan);
      const retry = await runClaude(retryArgs, session.config.cwd);
      if (!retry.error) {
        if (retry.sessionId) session.claudeSessionId = retry.sessionId;
        res.json({ ok: true, response: retry.output });
        return;
      }
    }
    res.json({ ok: false, error: result.error });
    return;
  }

  if (result.sessionId) session.claudeSessionId = result.sessionId;
  res.json({ ok: true, response: result.output });
});

// ─── Session send (streaming SSE) ────────────────────────────────────────────

app.post(`${PREFIX}/session/send-stream`, async (req: Request, res: Response) => {
  const { name, message, timeout: timeoutMs = 600_000, effort, plan, autoResume } = req.body as {
    name: string; message: string; timeout?: number;
    effort?: EffortLevel; plan?: boolean; autoResume?: boolean;
  };

  const session = getSession(name);
  if (!session) {
    res.status(404).json({ ok: false, error: `Session '${name}' not found` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const args = buildPrintArgs(
    message, session.config,
    session.claudeSessionId,
    effort || session.currentEffort,
    plan,
  );

  session.stats.lastActivity = new Date().toISOString();

  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: API_KEY, NO_COLOR: '1', TERM: 'dumb', ...buildExtraEnv(session.config) };
  const proc = spawn(CLAUDE_BIN, args, {
    cwd: session.config.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Write the prompt to stdin instead of passing it as a positional arg
  proc.stdin.write(message);
  proc.stdin.end();

  const abortTimer = setTimeout(() => { proc.kill('SIGTERM'); }, timeoutMs + 30_000);

  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev: StreamEvent = JSON.parse(trimmed);

        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          session.claudeSessionId = ev.session_id as string;
        }
        if (ev.type === 'assistant' && ev.message?.usage) {
          const u = ev.message.usage;
          session.stats.tokensIn += u.input_tokens || 0;
          session.stats.tokensOut += u.output_tokens || 0;
          session.stats.cachedTokens += u.cache_read_input_tokens || 0;
        }
        if (ev.type === 'tool_use') {
          session.stats.toolCalls++;
          sendEvent({ type: 'tool_use', tool: ev.name || ev.tool, input: ev.input });
        } else if (ev.type === 'tool_result') {
          if (ev.is_error) {
            session.stats.toolErrors++;
            if (session.hooks.onToolError) {
              fireWebhook(session.hooks.onToolError, { hook: 'onToolError', session: name, data: ev, timestamp: new Date().toISOString() });
            }
          }
          sendEvent({ type: 'tool_result' });
        } else if (ev.type === 'assistant' && ev.message?.content) {
          for (const c of ev.message.content as Array<{ type: string; text?: string }>) {
            if (c.type === 'text' && c.text) {
              sendEvent({ type: 'text', text: c.text });
            }
          }
        } else if (ev.type === 'result') {
          sendEvent({ type: 'done', text: ev.result, stop_reason: 'end_turn' });
        }
      } catch {
        // non-JSON, skip
      }
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    sendEvent({ type: 'error', error: chunk.toString() });
  });

  proc.on('close', (code) => {
    clearTimeout(abortTimer);
    session.stats.turns++;
    if (session.hooks.onTurnComplete) {
      fireWebhook(session.hooks.onTurnComplete, { hook: 'onTurnComplete', session: name, data: { tokensIn: session.stats.tokensIn }, timestamp: new Date().toISOString() });
    }
    if (code !== 0) {
      sendEvent({ type: 'error', error: `Process exited with code ${code}` });
      if (session.hooks.onStopFailure) {
        fireWebhook(session.hooks.onStopFailure, { hook: 'onStopFailure', session: name, data: { code }, timestamp: new Date().toISOString() });
      }
    }
    res.end();
  });

  req.on('close', () => { proc.kill('SIGTERM'); clearTimeout(abortTimer); });
});

// ─── Session management endpoints ────────────────────────────────────────────

app.get(`${PREFIX}/session/list`, (_req, res) => {
  const list = Array.from(sessions.values())
    .filter(s => !s.paused)
    .map(s => ({
      name: s.config.name,
      sessionName: s.config.sessionName,
      cwd: s.config.cwd,
      created: s.created,
      isReady: s.stats.isReady,
      claudeSessionId: s.claudeSessionId,
    }));
  res.json({ ok: true, sessions: list });
});

app.post(`${PREFIX}/session/stop`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  if (session.hooks.onStop) {
    fireWebhook(session.hooks.onStop, { hook: 'onStop', session: name, data: { stats: session.stats }, timestamp: new Date().toISOString() });
  }

  sessions.delete(name);
  res.json({ ok: true });
});

app.post(`${PREFIX}/session/status`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const uptime = Math.floor((Date.now() - new Date(session.created).getTime()) / 1000);
  res.json({
    ok: true,
    claudeSessionId: session.claudeSessionId,
    cwd: session.config.cwd,
    created: session.created,
    stats: { ...session.stats, uptime },
  });
});

app.post(`${PREFIX}/session/history`, (req: Request, res: Response) => {
  const { name, limit = 20 } = req.body as { name: string; limit?: number };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const history = session.claudeSessionId
    ? getClaudeSessionHistory(session.claudeSessionId, limit)
    : [];
  res.json({ ok: true, count: history.length, history });
});

app.post(`${PREFIX}/session/pause`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }
  session.paused = true;
  res.json({ ok: true });
});

app.post(`${PREFIX}/session/resume`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }
  session.paused = false;
  res.json({ ok: true });
});

app.post(`${PREFIX}/session/fork`, async (req: Request, res: Response) => {
  const { name, newName } = req.body as { name: string; newName: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }
  if (sessions.has(newName)) { res.json({ ok: false, error: `Session '${newName}' already exists` }); return; }

  const forked: ActiveSession = {
    ...session,
    config: { ...session.config, name: newName, forkSession: true, claudeResumeId: session.claudeSessionId },
    created: new Date().toISOString(),
    stats: { ...session.stats },
    hooks: { ...session.hooks },
    paused: false,
    outputBuffer: '',
    pendingResolvers: [],
    busy: false,
  };
  sessions.set(newName, forked);
  res.json({ ok: true, claudeSessionId: forked.claudeSessionId });
});

app.post(`${PREFIX}/session/branch`, async (req: Request, res: Response) => {
  const { name, newName, model, effort } = req.body as { name: string; newName: string; model?: string; effort?: EffortLevel };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const branchedConfig: SessionConfig = {
    ...session.config,
    name: newName,
    forkSession: true,
    claudeResumeId: session.claudeSessionId,
    ...(model && { model, resolvedModel: resolveModel(model, session.config.modelOverrides) }),
  };

  const branched: ActiveSession = {
    config: branchedConfig,
    claudeSessionId: session.claudeSessionId,
    created: new Date().toISOString(),
    stats: { ...session.stats, turns: 0 },
    hooks: {},
    paused: false,
    outputBuffer: '',
    pendingResolvers: [],
    busy: false,
    currentEffort: effort,
  };

  sessions.set(newName, branched);
  res.json({ ok: true, claudeSessionId: branched.claudeSessionId });
});

app.post(`${PREFIX}/session/search`, (req: Request, res: Response) => {
  const { query, project, since, limit = 20 } = req.body as {
    query?: string; project?: string; since?: string; limit?: number;
  };

  let results = Array.from(sessions.values()).map(s => ({
    name: s.config.name,
    sessionName: s.config.sessionName,
    cwd: s.config.cwd,
    created: s.created,
    summary: undefined as string | undefined,
  }));

  if (project) results = results.filter(s => s.cwd && s.cwd.includes(project));
  if (since) {
    let sinceMs = 0;
    const m = since.match(/^(\d+)([hmd])$/);
    if (m) {
      const n = parseInt(m[1], 10);
      sinceMs = Date.now() - n * ({ h: 3600_000, m: 60_000, d: 86400_000 }[m[2] as 'h' | 'm' | 'd'] || 0);
    } else {
      sinceMs = new Date(since).getTime();
    }
    results = results.filter(s => new Date(s.created).getTime() >= sinceMs);
  }
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(s => s.name.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  }

  res.json({ ok: true, sessions: results.slice(0, limit) });
});

app.post(`${PREFIX}/session/compact`, async (req: Request, res: Response) => {
  const { name, summary } = req.body as { name: string; summary?: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  // Compact by running /compact slash command via -p
  const compactPrompt = summary
    ? `/compact ${summary}`
    : '/compact';

  const tokensBefore = session.stats.tokensIn + session.stats.tokensOut;
  const result = await runClaude(
    buildPrintArgs(compactPrompt, session.config, session.claudeSessionId),
    session.config.cwd
  );

  if (result.sessionId) session.claudeSessionId = result.sessionId;
  // Reset token counts after compact
  const tokensAfter = Math.floor(tokensBefore * 0.3); // rough estimate
  session.stats.tokensIn = Math.floor(session.stats.tokensIn * 0.3);

  res.json({ ok: true, tokensBefore, tokensAfter });
});

app.post(`${PREFIX}/session/context`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const tokensUsed = session.stats.tokensIn + session.stats.tokensOut;
  const MODEL_CONTEXT: Record<string, number> = {
    'opus': 200_000, 'sonnet': 200_000, 'haiku': 200_000,
    'gemini-2.0-flash': 1_000_000, 'gemini-1.5-pro': 2_000_000,
    'gpt-4o': 128_000, 'gpt-5.4': 128_000,
  };
  const modelKey = (session.config.resolvedModel || session.config.model || '').toLowerCase();
  const tokensMax = Object.entries(MODEL_CONTEXT).find(([k]) => modelKey.includes(k))?.[1] || 200_000;
  const percentUsed = (tokensUsed / tokensMax) * 100;

  // Fire onContextHigh hook if > 70%
  if (percentUsed > 70 && session.hooks.onContextHigh) {
    fireWebhook(session.hooks.onContextHigh, { hook: 'onContextHigh', session: name, data: { percentUsed }, timestamp: new Date().toISOString() });
  }

  const suggestions: string[] = [];
  if (percentUsed > 70) suggestions.push('Run session-compact to reclaim context window');
  if (session.stats.turns > 20) suggestions.push('Consider forking the session for a fresh start');

  res.json({ ok: true, context: { tokensUsed, tokensMax, percentUsed, suggestions } });
});

app.post(`${PREFIX}/session/model`, (req: Request, res: Response) => {
  const { name, model } = req.body as { name: string; model: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const resolved = resolveModel(model, session.config.modelOverrides);
  session.config.model = model;
  session.config.resolvedModel = resolved;
  res.json({ ok: true, model: resolved });
});

app.post(`${PREFIX}/session/effort`, (req: Request, res: Response) => {
  const { name, effort } = req.body as { name: string; effort: EffortLevel };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  session.currentEffort = effort === 'auto' ? undefined : effort;
  res.json({ ok: true });
});

app.post(`${PREFIX}/session/cost`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const model = session.config.resolvedModel || session.config.model || 'default';
  const pricing = getPricing(model);
  const inputCost = (session.stats.tokensIn / 1_000_000) * pricing.inputPer1M;
  const outputCost = (session.stats.tokensOut / 1_000_000) * pricing.outputPer1M;
  const cachedCost = (session.stats.cachedTokens / 1_000_000) * pricing.cachedPer1M;
  const totalUsd = inputCost + outputCost + cachedCost;

  res.json({
    ok: true,
    cost: {
      model,
      tokensIn: session.stats.tokensIn,
      tokensOut: session.stats.tokensOut,
      cachedTokens: session.stats.cachedTokens,
      pricing,
      breakdown: { inputCost, outputCost, cachedCost },
      totalUsd,
    },
  });
});

app.post(`${PREFIX}/session/hooks`, (req: Request, res: Response) => {
  const { name, hooks } = req.body as { name: string; hooks?: HookConfig };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  if (hooks) {
    Object.assign(session.hooks, hooks);
    const registered = Object.keys(hooks).filter(k => (hooks as Record<string, string | undefined>)[k]);
    res.json({ ok: true, registered });
  } else {
    const available = ['onToolError', 'onContextHigh', 'onStop', 'onTurnComplete', 'onStopFailure'];
    const active = Object.keys(session.hooks).filter(k => (session.hooks as Record<string, string | undefined>)[k]);
    res.json({ ok: true, hooks: active, available });
  }
});

app.post(`${PREFIX}/session/restart`, (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  session.paused = false;
  session.stats.isReady = true;
  session.stats.lastActivity = new Date().toISOString();
  res.json({ ok: true });
});

// ─── Agent/Skill Management ──────────────────────────────────────────────────

function listMdFiles(dir: string): Array<{ name: string; file: string; description: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
      return { name: f.replace('.md', ''), file: f, description: match ? match[1].trim() : '' };
    });
}

app.get(`${PREFIX}/agents`, (req: Request, res: Response) => {
  const cwd = (req.query.cwd as string) || os.homedir();
  const projectAgents = listMdFiles(path.join(cwd, '.claude', 'agents'));
  const globalAgents = listMdFiles(path.join(os.homedir(), '.claude', 'agents'));
  const seen = new Set(projectAgents.map(a => a.name));
  const merged = [...projectAgents, ...globalAgents.filter(a => !seen.has(a.name))];
  res.json({ ok: true, agents: merged });
});

app.post(`${PREFIX}/agents/create`, (req: Request, res: Response) => {
  const { name, cwd, description, prompt } = req.body as { name: string; cwd?: string; description?: string; prompt?: string };
  if (!name) { res.json({ ok: false, error: "Missing 'name'" }); return; }
  const dir = path.join(cwd || os.homedir(), '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  const content = `---\ndescription: ${description || name}\n---\n\n${prompt || `You are ${name}.`}\n`;
  fs.writeFileSync(filePath, content);
  res.json({ ok: true, path: filePath });
});

app.get(`${PREFIX}/skills`, (req: Request, res: Response) => {
  const cwd = (req.query.cwd as string) || os.homedir();
  function listSkills(dir: string) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const skillMd = path.join(dir, d.name, 'SKILL.md');
        let description = '';
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8');
          const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
          if (match) description = match[1].trim();
        }
        return { name: d.name, hasSkillMd: fs.existsSync(skillMd), description };
      });
  }
  const projectSkills = listSkills(path.join(cwd, '.claude', 'skills'));
  const globalSkills = listSkills(path.join(os.homedir(), '.claude', 'skills'));
  const seen = new Set(projectSkills.map(s => s.name));
  const merged = [...projectSkills, ...globalSkills.filter(s => !seen.has(s.name))];
  res.json({ ok: true, skills: merged });
});

app.post(`${PREFIX}/skills/create`, (req: Request, res: Response) => {
  const { name, cwd, description, prompt, trigger } = req.body as {
    name: string; cwd?: string; description?: string; prompt?: string; trigger?: string;
  };
  if (!name) { res.json({ ok: false, error: "Missing 'name'" }); return; }
  const dir = path.join(cwd || os.homedir(), '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  let content = '---\n';
  if (description) content += `description: ${description}\n`;
  if (trigger) content += `trigger: ${trigger}\n`;
  content += `---\n\n${prompt || `# ${name}\n\nSkill instructions here.\n`}\n`;
  fs.writeFileSync(filePath, content);
  res.json({ ok: true, path: filePath });
});

app.post(`${PREFIX}/session/grep`, (req: Request, res: Response) => {
  const { name, pattern, limit = 50 } = req.body as { name: string; pattern: string; limit?: number };
  if (!name || !pattern) { res.json({ ok: false, error: "Missing 'name' or 'pattern'" }); return; }
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }
  // Search through session events stored in the outputBuffer or stats history
  // For now, search the output buffer
  const regex = new RegExp(pattern, 'gi');
  const lines = session.outputBuffer.split('\n').filter(l => regex.test(l));
  res.json({ ok: true, count: lines.length, matches: lines.slice(0, limit) });
});

// ─── Rules Management ────────────────────────────────────────────────────────

app.get(`${PREFIX}/rules`, (req: Request, res: Response) => {
  const cwd = (req.query.cwd as string) || os.homedir();
  function listRules(dir: string) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
        const pathsMatch = content.match(/^---\n[\s\S]*?paths:\s*(.+)/m);
        const ifMatch = content.match(/^---\n[\s\S]*?if:\s*(.+)/m);
        return {
          name: f.replace('.md', ''), file: f,
          description: descMatch ? descMatch[1].trim() : '',
          paths: pathsMatch ? pathsMatch[1].trim() : '',
          condition: ifMatch ? ifMatch[1].trim() : ''
        };
      });
  }
  const projectRules = listRules(path.join(cwd, '.claude', 'rules'));
  const globalRules = listRules(path.join(os.homedir(), '.claude', 'rules'));
  const seen = new Set(projectRules.map(r => r.name));
  const merged = [...projectRules, ...globalRules.filter(r => !seen.has(r.name))];
  res.json({ ok: true, rules: merged });
});

app.post(`${PREFIX}/rules/create`, (req: Request, res: Response) => {
  const { name, cwd, description, content, paths: rulePaths, condition } = req.body as {
    name: string; cwd?: string; description?: string; content?: string; paths?: string; condition?: string;
  };
  if (!name) { res.json({ ok: false, error: "Missing 'name'" }); return; }
  const dir = path.join(cwd || os.homedir(), '.claude', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  let fileContent = '---\n';
  if (description) fileContent += `description: ${description}\n`;
  if (rulePaths) fileContent += `paths: ${rulePaths}\n`;
  if (condition) fileContent += `if: ${condition}\n`;
  fileContent += `---\n\n${content || `# ${name}\n\nRule instructions here.\n`}\n`;
  fs.writeFileSync(filePath, fileContent);
  res.json({ ok: true, path: filePath });
});

// ─── Agent Teams ─────────────────────────────────────────────────────────────

app.post(`${PREFIX}/session/team-list`, async (req: Request, res: Response) => {
  const { name } = req.body as { name: string };
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const args = buildPrintArgs('/team', session.config, session.claudeSessionId);
  const result = await runClaude(args, session.config.cwd, undefined, buildExtraEnv(session.config));
  res.json({ ok: true, response: result.output });
});

app.post(`${PREFIX}/session/team-send`, async (req: Request, res: Response) => {
  const { name, teammate, message } = req.body as { name: string; teammate: string; message: string };
  if (!name || !teammate || !message) { res.json({ ok: false, error: "Missing 'name', 'teammate', or 'message'" }); return; }
  const session = getSession(name);
  if (!session) { res.json({ ok: false, error: `Session '${name}' not found` }); return; }

  const teamMessage = `@${teammate} ${message}`;
  const args = buildPrintArgs(teamMessage, session.config, session.claudeSessionId);
  const result = await runClaude(args, session.config.cwd, undefined, buildExtraEnv(session.config));
  session.stats.turns++;
  session.stats.lastActivity = new Date().toISOString();
  res.json({ ok: true, response: result.output });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-code-backend listening on http://127.0.0.1:${PORT}`);
  console.log(`  API prefix: ${PREFIX}`);
  console.log(`  CLAUDE_BIN: ${CLAUDE_BIN}`);
  console.log(`  API Key: ${API_KEY ? "✓ set" : "✗ not set (set ANTHROPIC_API_KEY)"}`);
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`\nReceived ${sig}, shutting down...`);
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    // Force exit after 5s if connections hang
    setTimeout(() => process.exit(1), 5000);
  });
}

export default app;
