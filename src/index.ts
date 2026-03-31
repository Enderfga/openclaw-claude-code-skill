/**
 * openclaw-claude-code — Plugin entry point
 *
 * Registers tools, hooks, and HTTP routes with the OpenClaw Plugin SDK.
 * When used standalone (no OpenClaw), exports SessionManager for direct use.
 *
 * Lazy initialisation: SessionManager and EmbeddedServer are created only on
 * the first tool call. While the plugin is registered but never used, it
 * consumes no memory beyond the tool schema definitions.
 */

import { SessionManager } from './session-manager.js';
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

    // ─── Lazy Init ────────────────────────────────────────────────────────
    //
    // Neither SessionManager nor EmbeddedServer is created at plugin load
    // time. They are initialised on the first tool invocation and reused
    // thereafter. This keeps memory overhead at zero for users who have the
    // plugin installed but do not actively use Claude Code sessions.

    let manager: SessionManager | null = null;
    let server: EmbeddedServer | null = null;

    function getManager(): SessionManager {
      if (!manager) {
        api.logger.info('[openclaw-claude-code] First use — initialising SessionManager and embedded server');
        manager = new SessionManager(rawConfig);
        server = new EmbeddedServer(manager);
        server.start().catch(err => api.logger.error('[openclaw-claude-code] Embedded server failed to start:', err));
      }
      return manager;
    }

    // ─── Service Lifecycle ────────────────────────────────────────────────

    api.registerService({
      id: 'openclaw-claude-code',
      start: () => api.logger.info('[openclaw-claude-code] Plugin registered (lazy init — will activate on first use)'),
      stop: () => {
        if (server) server.stop().catch(() => {});
        if (manager) manager.shutdown().catch(() => {});
        server = null;
        manager = null;
      },
    });

    // ─── Proxy HTTP Route (multi-model support) ───────────────────────────
    //
    // The proxy route handler itself is lightweight (just an HTTP handler
    // function); registering it eagerly is fine. The heavy proxy work only
    // happens when a request actually arrives.

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
          resumeSessionId:        { type: 'string', description: 'Resume an existing Claude Code session by its ID (e.g. from ~/.claude/sessions/). Replays conversation history via session/load instead of starting fresh.' },
        },
      },
      execute: async (_id, args) => {
        const info = await getManager().startSession(args as Parameters<SessionManager['startSession']>[0]);
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
        const result = await getManager().sendMessage(
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
        await getManager().stopSession(args.name as string);
        return { ok: true };
      },
    });

    // ─── Tool: claude_session_list ───────────────────────────────────────

    api.registerTool({
      name: 'claude_session_list',
      description: 'List all active Claude Code sessions',
      parameters: { type: 'object', properties: {} },
      execute: async (_id) => {
        // If nothing has been initialised yet, there are no sessions.
        if (!manager) return { ok: true, sessions: [] };
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
        const status = getManager().getStatus(args.name as string);
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
        const matches = await getManager().grepSession(
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
        await getManager().compactSession(args.name as string, args.summary as string | undefined);
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
        const agents = getManager().listAgents(args.cwd as string | undefined);
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
        const response = await getManager().teamList(args.name as string);
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
        const result = await getManager().teamSend(
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
