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
import { sanitizeCwd, validateRegex } from './validation.js';
import type { PluginConfig, EffortLevel, CouncilConfig, AgentPersona } from './types.js';

// ─── Standalone Export ───────────────────────────────────────────────────────

export { SessionManager } from './session-manager.js';
export { PersistentClaudeSession } from './persistent-session.js';
export { PersistentCodexSession } from './persistent-codex-session.js';
export { PersistentGeminiSession } from './persistent-gemini-session.js';
export { PersistentCursorSession } from './persistent-cursor-session.js';
export { Council, getDefaultCouncilConfig } from './council.js';
export { parseConsensus, stripConsensusTags, hasConsensusMarker } from './consensus.js';
export { sanitizeCwd, validateRegex, validateName } from './validation.js';
export type { ISession } from './types.js';
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
  description:
    'Full-featured Claude Code integration — session management, agent teams, worktree isolation, multi-model proxy',

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
        server.start().catch((err) => api.logger.error('[openclaw-claude-code] Embedded server failed to start:', err));
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
      description:
        'Start a persistent coding session. Supports multiple engines: claude (default) for Claude Code CLI, codex for OpenAI Codex CLI, gemini for Google Gemini CLI, cursor for Cursor Agent CLI.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name (auto-generated if omitted)' },
          cwd: { type: 'string', description: 'Working directory' },
          engine: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'cursor'],
            description: 'Engine to use (default: claude)',
          },
          model: { type: 'string', description: 'Model to use (opus, sonnet, haiku, gemini-pro, o4-mini, etc.)' },
          permissionMode: {
            type: 'string',
            enum: ['acceptEdits', 'bypassPermissions', 'default', 'delegate', 'dontAsk', 'plan', 'auto'],
          },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'max', 'auto'] },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tools to auto-approve' },
          disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Tools to deny' },
          maxTurns: { type: 'number', description: 'Max agent loop turns' },
          maxBudgetUsd: { type: 'number', description: 'Max API spend (USD)' },
          systemPrompt: { type: 'string', description: 'Replace system prompt' },
          appendSystemPrompt: { type: 'string', description: 'Append to system prompt' },
          agents: { type: 'object', description: 'Custom sub-agents JSON' },
          agent: { type: 'string', description: 'Default agent to use' },
          bare: { type: 'boolean', description: 'Minimal mode: skip hooks, LSP, auto-memory, CLAUDE.md' },
          worktree: { type: ['string', 'boolean'], description: 'Run in git worktree' },
          fallbackModel: { type: 'string', description: 'Auto fallback when primary overloaded' },
          jsonSchema: { type: 'string', description: 'JSON Schema for structured output' },
          mcpConfig: { type: ['string', 'array'], items: { type: 'string' }, description: 'MCP server config file(s)' },
          settings: { type: 'string', description: 'Settings.json path or inline JSON' },
          noSessionPersistence: { type: 'boolean', description: 'Do not save session to disk' },
          betas: { type: ['string', 'array'], items: { type: 'string' }, description: 'Custom beta headers' },
          enableAgentTeams: { type: 'boolean', description: 'Enable experimental agent teams' },
          enableAutoMode: { type: 'boolean', description: 'Enable auto permission mode' },
          resumeSessionId: {
            type: 'string',
            description:
              'Resume an existing Claude Code session by its ID (e.g. from ~/.claude/sessions/). Replays conversation history via session/load instead of starting fresh.',
          },
        },
      },
      execute: async (_id, args) => {
        const sanitized = { ...args };
        if (sanitized.cwd) sanitized.cwd = sanitizeCwd(sanitized.cwd as string);
        const info = await getManager().startSession(sanitized as Parameters<SessionManager['startSession']>[0]);
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
          name: { type: 'string', description: 'Session name' },
          message: { type: 'string', description: 'Message to send' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'], description: 'Effort for this message' },
          plan: { type: 'boolean', description: 'Enable plan mode' },
          timeout: { type: 'number', description: 'Timeout in ms (default 300000)' },
          stream: {
            type: 'boolean',
            description:
              'Collect text chunks as they arrive and include them in result.chunks[] (default false). Note: OpenClaw plugin SDK does not yet support mid-tool streaming to the caller, so chunks are buffered and returned with the final result.',
          },
        },
        required: ['name', 'message'],
      },
      execute: async (_id, args) => {
        const wantChunks = args.stream as boolean | undefined;
        const chunks: string[] = [];

        const result = await getManager().sendMessage(args.name as string, args.message as string, {
          effort: args.effort as EffortLevel | undefined,
          plan: args.plan as boolean | undefined,
          timeout: args.timeout as number | undefined,
          // When stream:true, collect chunks into array for caller.
          // True mid-tool streaming requires SDK-level support (not yet available).
          onChunk: wantChunks
            ? (chunk: string) => {
                chunks.push(chunk);
              }
            : undefined,
        });
        return {
          ok: true,
          ...result,
          ...(wantChunks ? { chunks } : {}),
        };
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
        if (!manager) return { ok: true, sessions: [], persisted: [] };
        return { ok: true, sessions: manager.listSessions(), persisted: manager.listPersistedSessions() };
      },
    });

    // ─── Tool: claude_sessions_overview ──────────────────────────────────

    api.registerTool({
      name: 'claude_sessions_overview',
      description:
        'Get an aggregate overview of all active Claude Code sessions — readiness, busy/paused state, cost, context usage, and last activity for each. Use this for a dashboard view across all sessions. For single-session detail, use claude_session_status instead.',
      parameters: { type: 'object', properties: {} },
      execute: async (_id) => {
        if (!manager)
          return { ok: true, version: 'unknown', sessions: 0, sessionNames: [], uptime: process.uptime(), details: [] };
        return manager.health();
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
          name: { type: 'string', description: 'Session name' },
          pattern: { type: 'string', description: 'Regex pattern to search' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['name', 'pattern'],
      },
      execute: async (_id, args) => {
        validateRegex(args.pattern as string);
        const matches = await getManager().grepSession(
          args.name as string,
          args.pattern as string,
          args.limit as number | undefined,
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
          name: { type: 'string', description: 'Session name' },
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
        const agents = getManager().listAgents(sanitizeCwd(args.cwd as string | undefined));
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
          name: { type: 'string', description: 'Session name' },
          teammate: { type: 'string', description: 'Teammate name' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['name', 'teammate', 'message'],
      },
      execute: async (_id, args) => {
        const result = await getManager().teamSend(
          args.name as string,
          args.teammate as string,
          args.message as string,
        );
        return { ok: true, ...result };
      },
    });

    // ─── Tool: claude_session_update_tools ───────────────────────────────

    api.registerTool({
      name: 'claude_session_update_tools',
      description:
        'Update allowedTools or disallowedTools for a running session. Restarts the session process with --resume to apply the new tool constraints while preserving conversation history. Rejects if the session is currently busy.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'New allowedTools list (replaces existing, or merges if merge:true)',
          },
          disallowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'New disallowedTools list (replaces existing, or merges if merge:true)',
          },
          removeTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools to remove from allowedTools/disallowedTools (applied after merge)',
          },
          merge: { type: 'boolean', description: 'Merge with existing lists instead of replacing (default false)' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const info = await getManager().updateTools(args.name as string, {
          allowedTools: args.allowedTools as string[] | undefined,
          disallowedTools: args.disallowedTools as string[] | undefined,
          removeTools: args.removeTools as string[] | undefined,
          merge: args.merge as boolean | undefined,
        });
        return { ok: true, restarted: true, ...info };
      },
    });

    // ─── Tool: claude_session_switch_model ───────────────────────────────

    api.registerTool({
      name: 'claude_session_switch_model',
      description:
        'Switch the model for a running session immediately. Restarts the session process with --resume so the new model takes effect on the next message while preserving conversation history.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          model: { type: 'string', description: 'New model (opus, sonnet, haiku, gemini-pro, etc.)' },
        },
        required: ['name', 'model'],
      },
      execute: async (_id, args) => {
        const info = await getManager().switchModel(args.name as string, args.model as string);
        return { ok: true, restarted: true, ...info };
      },
    });

    // ─── Tool: council_start ────────────────────────────────────────────

    api.registerTool({
      name: 'council_start',
      description:
        'Start a multi-agent council that collaborates on a task using git worktree isolation, round-based execution, and consensus voting. Agents can use different engines (Claude, Codex) and models.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description for the council to work on' },
          projectDir: { type: 'string', description: 'Working directory for the council project' },
          agents: {
            type: 'array',
            description: 'Agent personas. Defaults to 3-agent team (Architect, Engineer, Reviewer) if omitted.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Agent display name' },
                emoji: { type: 'string', description: 'Agent emoji identifier' },
                persona: { type: 'string', description: 'Agent personality/expertise description' },
                engine: {
                  type: 'string',
                  enum: ['claude', 'codex', 'gemini', 'cursor'],
                  description: 'Engine (default: claude)',
                },
                model: { type: 'string', description: 'Model to use' },
                baseUrl: { type: 'string', description: 'Custom API endpoint (for proxy)' },
              },
              required: ['name', 'emoji', 'persona'],
            },
          },
          maxRounds: { type: 'number', description: 'Max collaboration rounds (default 15)' },
          agentTimeoutMs: { type: 'number', description: 'Per-agent timeout in ms (default 1800000)' },
          maxTurnsPerAgent: { type: 'number', description: 'Max tool turns per agent per round (default 30)' },
          maxBudgetUsd: { type: 'number', description: 'Max API spend per agent (USD)' },
        },
        required: ['task', 'projectDir'],
      },
      execute: async (_id, args) => {
        const { getDefaultCouncilConfig } = await import('./council.js');
        const projectDir = sanitizeCwd(args.projectDir as string)!;
        const defaultConfig = getDefaultCouncilConfig(projectDir);

        const config: CouncilConfig = {
          name: 'council',
          agents: (args.agents as AgentPersona[] | undefined) || defaultConfig.agents,
          maxRounds: (args.maxRounds as number | undefined) ?? defaultConfig.maxRounds,
          projectDir,
          agentTimeoutMs: args.agentTimeoutMs as number | undefined,
          maxTurnsPerAgent: args.maxTurnsPerAgent as number | undefined,
          maxBudgetUsd: args.maxBudgetUsd as number | undefined,
        };

        const session = getManager().councilStart(args.task as string, config);
        return { ok: true, ...session, note: 'Council running in background. Poll with council_status.' };
      },
    });

    // ─── Tool: council_status ───────────────────────────────────────────

    api.registerTool({
      name: 'council_status',
      description: 'Get the status of a running council session',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const session = getManager().councilStatus(args.id as string);
        if (!session) return { ok: false, error: 'Council not found' };
        return { ok: true, ...session };
      },
    });

    // ─── Tool: council_abort ────────────────────────────────────────────

    api.registerTool({
      name: 'council_abort',
      description: 'Abort a running council, stopping all agent sessions',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        getManager().councilAbort(args.id as string);
        return { ok: true };
      },
    });

    // ─── Tool: council_inject ───────────────────────────────────────────

    api.registerTool({
      name: 'council_inject',
      description:
        'Inject a user message into the next round of a running council. The message will be appended to all agent prompts in the next round.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Council session ID' },
          message: { type: 'string', description: 'Message to inject' },
        },
        required: ['id', 'message'],
      },
      execute: async (_id, args) => {
        getManager().councilInject(args.id as string, args.message as string);
        return { ok: true };
      },
    });

    // ─── Tool: council_review ──────────────────────────────────────────

    api.registerTool({
      name: 'council_review',
      description:
        'Review a completed council session. Returns a structured report of all changed files, branches, worktrees, plan.md status, review files, and agent summaries. Does not modify any state — purely informational. Use this before deciding to accept or reject.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = await getManager().councilReview(args.id as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tool: council_accept ──────────────────────────────────────────

    api.registerTool({
      name: 'council_accept',
      description:
        'Accept and finalize council work. Cleans up all council scaffolding: removes worktrees, deletes council/* branches, removes plan.md and reviews/ directory. Only call after reviewing with council_review.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Council session ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = await getManager().councilAccept(args.id as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tool: council_reject ──────────────────────────────────────────

    api.registerTool({
      name: 'council_reject',
      description:
        'Reject council work and provide feedback. Rewrites plan.md with rejection feedback and commits it. Does NOT delete any worktrees or branches — the council can be restarted to retry. Use this when the council output is incomplete or broken.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Council session ID' },
          feedback: {
            type: 'string',
            description: 'Detailed feedback explaining why the work is rejected and what needs to be fixed',
          },
        },
        required: ['id', 'feedback'],
      },
      execute: async (_id, args) => {
        const result = await getManager().councilReject(args.id as string, args.feedback as string);
        return { ok: true, ...result };
      },
    });

    // ─── Tool: claude_session_send_to ─────────────────────────────────

    api.registerTool({
      name: 'claude_session_send_to',
      description:
        'Send a cross-session message from one session to another. If the target is idle, the message is delivered immediately. If busy, it is queued in the inbox for later delivery. Use "*" as target to broadcast to all other sessions.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Sender session name' },
          to: { type: 'string', description: 'Target session name, or "*" for broadcast' },
          message: { type: 'string', description: 'Message text' },
          summary: { type: 'string', description: 'Short preview (5-10 words)' },
        },
        required: ['from', 'to', 'message'],
      },
      execute: async (_id, args) => {
        const result = await getManager().sessionSendTo(
          args.from as string,
          args.to as string,
          args.message as string,
          args.summary as string | undefined,
        );
        return { ok: true, ...result };
      },
    });

    // ─── Tool: claude_session_inbox ──────────────────────────────────

    api.registerTool({
      name: 'claude_session_inbox',
      description: 'Read inbox messages for a session. Returns unread messages by default.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          unreadOnly: { type: 'boolean', description: 'Only unread messages (default true)' },
        },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const messages = getManager().sessionInbox(
          args.name as string,
          (args.unreadOnly as boolean | undefined) ?? true,
        );
        return { ok: true, count: messages.length, messages };
      },
    });

    // ─── Tool: claude_session_deliver_inbox ──────────────────────────

    api.registerTool({
      name: 'claude_session_deliver_inbox',
      description:
        'Deliver all queued inbox messages to an idle session. Call this when a session finishes a task to process waiting messages.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Session name' } },
        required: ['name'],
      },
      execute: async (_id, args) => {
        const count = await getManager().sessionDeliverInbox(args.name as string);
        return { ok: true, delivered: count };
      },
    });

    // ─── Tool: ultraplan_start ──────────────────────────────────────

    api.registerTool({
      name: 'ultraplan_start',
      description:
        'Start an Ultraplan session: a dedicated Opus planning session that explores your project for up to 30 minutes and produces a detailed implementation plan. Runs in background.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to plan — describe the feature, refactor, or problem' },
          cwd: { type: 'string', description: 'Project directory to explore' },
          model: { type: 'string', description: 'Model to use (default: opus)' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 1800000 = 30 min)' },
        },
        required: ['task'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultraplanStart(args.task as string, {
          cwd: sanitizeCwd(args.cwd as string | undefined),
          model: args.model as string | undefined,
          timeout: args.timeout as number | undefined,
        });
        return { ok: true, ...result, note: 'Ultraplan running in background. Poll with ultraplan_status.' };
      },
    });

    // ─── Tool: ultraplan_status ─────────────────────────────────────

    api.registerTool({
      name: 'ultraplan_status',
      description: 'Get the status of an Ultraplan session. Returns the plan text when completed.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ultraplan ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultraplanStatus(args.id as string);
        if (!result) return { ok: false, error: 'Ultraplan not found' };
        return { ok: true, ...result };
      },
    });

    // ─── Tool: ultrareview_start ────────────────────────────────────

    api.registerTool({
      name: 'ultrareview_start',
      description:
        'Start an Ultrareview: a fleet of bug-hunting agents (5-20) that review your codebase from different angles in parallel. Each agent specializes in a different area (security, performance, logic, types, etc.). Runs in background.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project directory to review' },
          agentCount: { type: 'number', description: 'Number of reviewer agents (1-20, default 5)' },
          maxDurationMinutes: { type: 'number', description: 'Max review duration in minutes (5-25, default 10)' },
          model: { type: 'string', description: 'Model for reviewers (default: session default)' },
          focus: { type: 'string', description: 'Review focus area (default: bugs + security + quality)' },
        },
        required: ['cwd'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultrareviewStart(sanitizeCwd(args.cwd as string)!, {
          agentCount: args.agentCount as number | undefined,
          maxDurationMinutes: args.maxDurationMinutes as number | undefined,
          model: args.model as string | undefined,
          focus: args.focus as string | undefined,
        });
        return { ok: true, ...result, note: 'Ultrareview running in background. Poll with ultrareview_status.' };
      },
    });

    // ─── Tool: ultrareview_status ───────────────────────────────────

    api.registerTool({
      name: 'ultrareview_status',
      description: 'Get the status of an Ultrareview. Returns all findings when completed.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ultrareview ID' } },
        required: ['id'],
      },
      execute: async (_id, args) => {
        const result = getManager().ultrareviewStatus(args.id as string);
        if (!result) return { ok: false, error: 'Ultrareview not found' };
        return { ok: true, ...result };
      },
    });
  },
};

export default plugin;
