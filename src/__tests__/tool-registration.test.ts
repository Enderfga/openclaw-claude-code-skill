import { describe, it, expect } from 'vitest';
import plugin from '../index.js';

interface RegisteredTool {
  name: string;
  description: string;
}

function collectRegisteredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  // Minimal stub PluginAPI — just enough to capture registerTool calls.
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: { name: string; description: string }) => {
      tools.push({ name: def.name, description: def.description });
    },
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return tools;
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

const DEPRECATED_ALIASES = CANONICAL_RENAMED_TOOLS.map((n) => `claude_${n}`);

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
  const tools = collectRegisteredTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  it('registers all canonical engine-neutral tool names', () => {
    for (const name of CANONICAL_RENAMED_TOOLS) {
      expect(byName.has(name), `missing canonical tool: ${name}`).toBe(true);
    }
  });

  it('registers all v2.x deprecated aliases', () => {
    for (const alias of DEPRECATED_ALIASES) {
      expect(byName.has(alias), `missing alias: ${alias}`).toBe(true);
    }
  });

  it('marks every deprecated alias with [DEPRECATED] in its description', () => {
    for (const alias of DEPRECATED_ALIASES) {
      const tool = byName.get(alias);
      expect(tool?.description, `alias ${alias} has no description`).toBeTruthy();
      expect(tool?.description).toMatch(/\[DEPRECATED/);
    }
  });

  it('keeps codex_*, council_*, ultra* tool names unchanged', () => {
    for (const name of UNCHANGED_TOOLS) {
      expect(byName.has(name), `missing unchanged tool: ${name}`).toBe(true);
    }
  });
});
