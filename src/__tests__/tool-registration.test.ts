import { describe, it, expect } from 'vitest';
import plugin from '../index.js';

interface RegisteredTool {
  name: string;
  description: string;
}

interface RegisteredRoute {
  path: string;
}

function collectRegistration(): { tools: RegisteredTool[]; routes: RegisteredRoute[] } {
  const tools: RegisteredTool[] = [];
  const routes: RegisteredRoute[] = [];
  // Minimal stub PluginAPI — just enough to capture registration calls.
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: { name: string; description: string }) => {
      tools.push({ name: def.name, description: def.description });
    },
    on: () => {},
    registerHttpRoute: (def: { path: string }) => {
      routes.push({ path: def.path });
    },
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return { tools, routes };
}

const CANONICAL_RENAMED_TOOLS = [
  'session_start',
  'session_send',
  'session_stop',
  'session_list',
  'sessions_overview',
  'session_status',
  'session_grep',
  'session_compact',
  'agents_list',
  'team_list',
  'team_send',
  'session_update_tools',
  'session_switch_model',
  'project_purge',
  'session_send_to',
  'session_inbox',
  'session_deliver_inbox',
];

const UNCHANGED_TOOLS = [
  'codex_resume',
  'codex_review',
  'codex_goal_set',
  'codex_goal_get',
  'codex_goal_pause',
  'codex_goal_resume',
  'codex_goal_clear',
  'council_start',
  'council_status',
  'council_abort',
  'council_inject',
  'council_review',
  'council_accept',
  'council_reject',
  'ultraplan_start',
  'ultraplan_status',
  'ultrareview_start',
  'ultrareview_status',
];

describe('plugin tool registration', () => {
  const { tools, routes } = collectRegistration();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const routePaths = new Set(routes.map((r) => r.path));

  it('registers all canonical engine-neutral tool names', () => {
    for (const name of CANONICAL_RENAMED_TOOLS) {
      expect(byName.has(name), `missing canonical tool: ${name}`).toBe(true);
    }
  });

  it('does not register deprecated engine-coupled aliases', () => {
    // v3.0 aliases (claude_session_*, claude_team_*, etc.) were removed in v3.1.
    for (const tool of tools) {
      expect(tool.name.startsWith('claude_'), `deprecated alias still registered: ${tool.name}`).toBe(false);
    }
  });

  it('keeps codex_*, council_*, ultra* tool names unchanged', () => {
    for (const name of UNCHANGED_TOOLS) {
      expect(byName.has(name), `missing unchanged tool: ${name}`).toBe(true);
    }
  });

  it('keeps the legacy proxy route as a compatibility alias', () => {
    expect(routePaths.has('/v1/claw-orchestrator-proxy')).toBe(true);
    expect(routePaths.has('/v1/claude-code-proxy')).toBe(true);
  });
});
