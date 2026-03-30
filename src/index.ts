/**
 * openclaw-claude-code — Plugin entry point
 *
 * Registers tools, hooks, and HTTP routes with the OpenClaw Plugin SDK.
 * When used standalone (no OpenClaw), exports SessionManager for direct use.
 */

import { SessionManager } from './session-manager.js';
import { registerPromptBypass } from './hooks/prompt-bypass.js';
import { createProxyHandler } from './proxy/handler.js';
import { EmbeddedServer } from './embedded-server.js';
import type { PluginConfig, EffortLevel } from './types.js';

// ─── Standalone Export ───────────────────────────────────────────────────────

export { SessionManager } from './session-manager.js';
export { PersistentClaudeSession } from './persistent-session.js';
export * from './types.js';

// ─── Plugin Entry ────────────────────────────────────────────────────────────

/** OpenClaw Plugin SDK interface (minimal typing for what we use) */
interface PluginAPI {
  pluginConfig: Record<string, unknown>;
  logger: { info(...args: unknown[]): void; error(...args: unknown[]): void; warn(...args: unknown[]): void };
  registerTool(def: {
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => Promise<void>): void;
  registerHttpRoute(def: {
    path: string;
    auth?: string;
    match?: string;
    handler: (req: unknown, res: unknown) => Promise<boolean>;
  }): void;
  registerService(def: { id: string; start: () => void; stop: () => void }): void;
}

/**
 * OpenClaw plugin object — standard format
 */
const plugin = {
  id: 'openclaw-claude-code',
  name: 'Claude Code SDK',
  description: 'Full-featured Claude Code integration — session management, agent teams, worktree isolation, multi-model proxy',

  register(api: PluginAPI): void {
    const rawConfig = (api.pluginConfig || {}) as Partial<PluginConfig>;
  const manager = new SessionManager(rawConfig);

  // Start embedded HTTP server for CLI access
  const server = new EmbeddedServer(manager);
  server.start().catch(err => api.logger.error('[plugin] Embedded server failed:', err));

  // Service lifecycle
  api.registerService({
    id: 'openclaw-claude-code',
    start: () => api.logger.info('openclaw-claude-code: plugin loaded'),
    stop: () => { server.stop().catch(() => {}); manager.shutdown().catch(() => {}); },
  });

  // Register proxy HTTP route (multi-model support)
  if (rawConfig.proxy?.enabled !== false) {
    const proxyHandler = createProxyHandler(rawConfig.proxy, {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      geminiApiKey: process.env.GEMINI_API_KEY,
      gatewayUrl: process.env.GATEWAY_URL,
      gatewayKey: process.env.GATEWAY_KEY,
    });
    api.registerHttpRoute({
      path: '/v1/claude-code-proxy',
      auth: 'gateway',
      match: 'prefix',
      handler: proxyHandler as unknown as (req: unknown, res: unknown) => Promise<boolean>,
    });
  }

  // ─── Tool: claude_session_start ──────────────────────────────────────

  api.registerTool({
    name: 'claude_session_start',
    description: 'Start a persistent Claude Code session with full CLI flag support (model, effort, worktree, bare, agent teams, etc.)',
    parameters: {
      type: 'object',
      properties: {
        name:                   { type: 'string', description: 'Session name (auto-generated if omitted)' },
        cwd:                    { type: 'string', description: 'Working directory' },
        model:                  { type: 'string', description: 'Model to use (opus, sonnet, haiku, gemini-pro, etc.)' },
        permissionMode:         { type: 'string', enum: ['acceptEdits', 'bypassPermissions', 'default', 'delegate', 'dontAsk', 'plan', 'auto'] },
        effort:                 { type: 'string', enum: ['low', 'medium', 'high', 'max', 'auto'] },
        allowedTools:           { type: 'array', items: { type: 'string' }, description: 'Tools to auto-approve' },
        disallowedTools:        { type: 'array', items: { type: 'string' }, description: 'Tools to deny' },
        maxTurns:               { type: 'number', description: 'Max agent loop turns' },
        maxBudgetUsd:           { type: 'number', description: 'Max API spend (USD)' },
        systemPrompt:           { type: 'string', description: 'Replace system prompt' },
        appendSystemPrompt:     { type: 'string', description: 'Append to system prompt' },
        agents:                 { type: 'object', description: 'Custom sub-agents JSON' },
        agent:                  { type: 'string', description: 'Default agent to use' },
        bare:                   { type: 'boolean', description: 'Minimal mode: skip hooks, LSP, auto-memory, CLAUDE.md' },
        worktree:               { type: ['string', 'boolean'], description: 'Run in git worktree' },
        fallbackModel:          { type: 'string', description: 'Auto fallback when primary overloaded' },
        jsonSchema:             { type: 'string', description: 'JSON Schema for structured output' },
        mcpConfig:              { type: ['string', 'array'], description: 'MCP server config file(s)' },
        settings:               { type: 'string', description: 'Settings.json path or inline JSON' },
        noSessionPersistence:   { type: 'boolean', description: 'Do not save session to disk' },
        betas:                  { type: ['string', 'array'], description: 'Custom beta headers' },
        enableAgentTeams:       { type: 'boolean', description: 'Enable experimental agent teams' },
        enableAutoMode:         { type: 'boolean', description: 'Enable auto permission mode' },
      },
    },
    execute: async (_id, args) => {
      const info = await manager.startSession(args as Parameters<SessionManager['startSession']>[0]);
      return { ok: true, ...info };
    },
  });

  // ─── Tool: claude_session_send ───────────────────────────────────────

  api.registerTool({
    name: 'claude_session_send',
    description: 'Send a message to a persistent Claude Code session and get the response',
    parameters: {
      type: 'object',
      properties: {
        name:       { type: 'string', description: 'Session name' },
        message:    { type: 'string', description: 'Message to send' },
        effort:     { type: 'string', enum: ['low', 'medium', 'high', 'max'], description: 'Effort for this message' },
        plan:       { type: 'boolean', description: 'Enable plan mode' },
        timeout:    { type: 'number', description: 'Timeout in ms (default 300000)' },
      },
      required: ['name', 'message'],
    },
    execute: async (_id, args) => {
      const result = await manager.sendMessage(
        args.name as string,
        args.message as string,
        {
          effort: args.effort as EffortLevel | undefined,
          plan: args.plan as boolean | undefined,
          timeout: args.timeout as number | undefined,
        }
      );
      return { ok: true, ...result };
    },
  });

  // ─── Tool: claude_session_stop ───────────────────────────────────────

  api.registerTool({
    name: 'claude_session_stop',
    description: 'Stop a persistent Claude Code session',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Session name' } },
      required: ['name'],
    },
    execute: async (_id, args) => {
      await manager.stopSession(args.name as string);
      return { ok: true };
    },
  });

  // ─── Tool: claude_session_list ───────────────────────────────────────

  api.registerTool({
    name: 'claude_session_list',
    description: 'List all active Claude Code sessions',
    parameters: { type: 'object', properties: {} },
    execute: async (_id) => {
      return { ok: true, sessions: manager.listSessions() };
    },
  });

  // ─── Tool: claude_session_status ─────────────────────────────────────

  api.registerTool({
    name: 'claude_session_status',
    description: 'Get detailed status of a Claude Code session (context %, tokens, cost, uptime)',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Session name' } },
      required: ['name'],
    },
    execute: async (_id, args) => {
      const status = manager.getStatus(args.name as string);
      return { ok: true, ...status };
    },
  });

  // ─── Tool: claude_session_grep ───────────────────────────────────────

  api.registerTool({
    name: 'claude_session_grep',
    description: 'Search session history for events matching a regex pattern',
    parameters: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Session name' },
        pattern: { type: 'string', description: 'Regex pattern to search' },
        limit:   { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['name', 'pattern'],
    },
    execute: async (_id, args) => {
      const matches = await manager.grepSession(
        args.name as string,
        args.pattern as string,
        args.limit as number | undefined
      );
      return { ok: true, count: matches.length, matches };
    },
  });

  // ─── Tool: claude_session_compact ────────────────────────────────────

  api.registerTool({
    name: 'claude_session_compact',
    description: 'Compact a session to reclaim context window space',
    parameters: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Session name' },
        summary: { type: 'string', description: 'Optional summary for compaction' },
      },
      required: ['name'],
    },
    execute: async (_id, args) => {
      await manager.compactSession(args.name as string, args.summary as string | undefined);
      return { ok: true };
    },
  });

  // ─── Tool: claude_agents_list ────────────────────────────────────────

  api.registerTool({
    name: 'claude_agents_list',
    description: 'List agent definitions from .claude/agents/',
    parameters: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Project directory' } },
    },
    execute: async (_id, args) => {
      const agents = manager.listAgents(args.cwd as string | undefined);
      return { ok: true, agents };
    },
  });

  // ─── Tool: claude_team_list ──────────────────────────────────────────

  api.registerTool({
    name: 'claude_team_list',
    description: 'List teammates in an agent team session (requires enableAgentTeams)',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Session name' } },
      required: ['name'],
    },
    execute: async (_id, args) => {
      const response = await manager.teamList(args.name as string);
      return { ok: true, response };
    },
  });

  // ─── Tool: claude_team_send ──────────────────────────────────────────

  api.registerTool({
    name: 'claude_team_send',
    description: 'Send a message to a specific teammate in an agent team session',
    parameters: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Session name' },
        teammate:  { type: 'string', description: 'Teammate name' },
        message:   { type: 'string', description: 'Message to send' },
      },
      required: ['name', 'teammate', 'message'],
    },
    execute: async (_id, args) => {
      const result = await manager.teamSend(
        args.name as string,
        args.teammate as string,
        args.message as string
      );
      return { ok: true, ...result };
    },
  });
  },
};

export default plugin;
