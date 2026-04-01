#!/usr/bin/env node
/**
 * claude-code-skill CLI — connects to the embedded server (auto-started by plugin)
 *
 * When the plugin is installed, the embedded server starts automatically.
 * This CLI is just an HTTP client — zero configuration needed.
 *
 * For standalone use (no OpenClaw), run: claude-code-skill serve
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';

function getBaseUrl(): string {
  return process.env.CLAUDE_CODE_API_URL || 'http://127.0.0.1:18796';
}

function getCliVersion(): string {
  try {
    const _require = createRequire(import.meta.url);
    const pkg = _require('../package.json') as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

async function api(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const base = getBaseUrl();
    const resp = await fetch(`${base}${path}`, opts);
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `Cannot connect to ${getBaseUrl()} — is the plugin running?` };
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();
program.name('claude-code-skill').description('Claude Code SDK CLI').version(getCliVersion());

// Serve (standalone mode — no OpenClaw needed)
program
  .command('serve')
  .description('Start standalone embedded server (for use without OpenClaw)')
  .option('-p, --port <port>', 'Port', '18796')
  .action(async (opts) => {
    const { SessionManager } = await import('../src/session-manager.js');
    const { EmbeddedServer } = await import('../src/embedded-server.js');
    const manager = new SessionManager();
    const server = new EmbeddedServer(manager, parseInt(opts.port));
    const port = await server.start();
    if (port) {
      console.log(`Standalone server running on http://127.0.0.1:${port}`);
      console.log('Press Ctrl+C to stop');
      process.on('SIGINT', async () => {
        await server.stop();
        await manager.shutdown();
        process.exit(0);
      });
      process.on('SIGTERM', async () => {
        await server.stop();
        await manager.shutdown();
        process.exit(0);
      });
    }
  });

// Session commands
program
  .command('session-start [name]')
  .description('Start a persistent coding session (Claude Code, Codex, or Gemini)')
  .option('-d, --cwd <dir>', 'Working directory')
  .option('-e, --engine <engine>', 'Engine: claude (default), codex, or gemini')
  .option('-m, --model <model>', 'Model to use')
  .option('--permission-mode <mode>', 'Permission mode', 'acceptEdits')
  .option('--effort <level>', 'Effort level')
  .option('--allowed-tools <tools>', 'Comma-separated tools to auto-approve')
  .option('--max-turns <n>', 'Max agent loop turns')
  .option('--max-budget <usd>', 'Max API spend')
  .option('--system-prompt <prompt>', 'Replace system prompt')
  .option('--append-system-prompt <prompt>', 'Append to system prompt')
  .option('--agents <json>', 'Custom sub-agents JSON')
  .option('--agent <name>', 'Default agent')
  .option('--bare', 'Minimal mode')
  .option('-w, --worktree [name]', 'Git worktree')
  .option('--fallback-model <model>', 'Fallback model')
  .option('--json-schema <schema>', 'JSON Schema for structured output')
  .option('--mcp-config <paths>', 'MCP config files')
  .option('--settings <pathOrJson>', 'Settings.json')
  .option('--skip-persistence', 'Disable session persistence')
  .option('--betas <headers>', 'Custom beta headers')
  .option('--enable-agent-teams', 'Enable agent teams')
  .action(async (name, opts) => {
    const body: Record<string, unknown> = { name: name || `session-${Date.now()}` };
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.engine) body.engine = opts.engine;
    if (opts.model) body.model = opts.model;
    if (opts.permissionMode) body.permissionMode = opts.permissionMode;
    if (opts.effort) body.effort = opts.effort;
    if (opts.allowedTools) body.allowedTools = opts.allowedTools.split(',');
    if (opts.maxTurns) body.maxTurns = parseInt(opts.maxTurns);
    if (opts.maxBudget) body.maxBudgetUsd = parseFloat(opts.maxBudget);
    if (opts.systemPrompt) body.systemPrompt = opts.systemPrompt;
    if (opts.appendSystemPrompt) body.appendSystemPrompt = opts.appendSystemPrompt;
    if (opts.agents) body.agents = JSON.parse(opts.agents);
    if (opts.agent) body.agent = opts.agent;
    if (opts.bare) body.bare = true;
    if (opts.worktree !== undefined) body.worktree = typeof opts.worktree === 'string' ? opts.worktree : true;
    if (opts.fallbackModel) body.fallbackModel = opts.fallbackModel;
    if (opts.jsonSchema) body.jsonSchema = opts.jsonSchema;
    if (opts.mcpConfig) body.mcpConfig = opts.mcpConfig.split(',');
    if (opts.settings) body.settings = opts.settings;
    if (opts.skipPersistence) body.noSessionPersistence = true;
    if (opts.betas) body.betas = opts.betas.split(',');
    if (opts.enableAgentTeams) body.enableAgentTeams = true;

    const result = await api('/session/start', 'POST', body);
    if (result.ok) {
      console.log(`Session '${body.name}' started!`);
      if (result.claudeSessionId) console.log(`Claude Session ID: ${result.claudeSessionId}`);
    } else console.error(`Failed: ${result.error}`);
  });

program
  .command('session-send <name> <message>')
  .description('Send a message to a session')
  .option('--effort <level>', 'Effort level')
  .option('--plan', 'Plan mode')
  .option('-t, --timeout <ms>', 'Timeout', '300000')
  .option('-s, --stream', 'Collect streaming chunks and include in output')
  .action(async (name, message, opts) => {
    const result = await api('/session/send', 'POST', {
      name,
      message,
      effort: opts.effort,
      plan: opts.plan,
      timeout: parseInt(opts.timeout),
      stream: opts.stream || undefined,
    });
    if (result.ok) {
      console.log(result.output);
      if (opts.stream && Array.isArray(result.chunks) && result.chunks.length > 0) {
        console.log(`\n[${result.chunks.length} streaming chunks collected]`);
      }
    } else console.error(`Failed: ${result.error}`);
  });

program
  .command('session-stop <name>')
  .description('Stop a session')
  .action(async (name) => {
    const r = await api('/session/stop', 'POST', { name });
    if (r.ok) console.log(`Session '${name}' stopped.`);
    else console.error(`Failed: ${r.error}`);
  });

program
  .command('session-list')
  .description('List sessions')
  .action(async () => {
    const r = await api('/session/list');
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      return;
    }
    const sessions = r.sessions as Array<{ name: string; model?: string; cwd: string }>;
    if (!sessions.length) {
      console.log('No active sessions.');
      return;
    }
    for (const s of sessions) console.log(`  ${s.name} — ${s.model || 'default'} (${s.cwd})`);
  });

program
  .command('session-status <name>')
  .description('Get session status')
  .action(async (name) => {
    const r = await api('/session/status', 'POST', { name });
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      return;
    }
    const s = r.stats as Record<string, unknown>;
    console.log(`Session: ${name}`);
    console.log(`  Turns: ${s.turns}, Tools: ${s.toolCalls}, Cost: $${s.costUsd}`);
    console.log(`  Tokens: ${s.tokensIn} in / ${s.tokensOut} out`);
    console.log(`  Uptime: ${s.uptime}s`);
  });

program
  .command('session-grep <name> <pattern>')
  .description('Search session history')
  .option('-n, --limit <n>', 'Max results', '50')
  .action(async (name, pattern, opts) => {
    const r = await api('/session/grep', 'POST', { name, pattern, limit: parseInt(opts.limit) });
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      return;
    }
    console.log(`Found ${r.count} match(es)`);
    for (const m of r.matches as Array<Record<string, string>>) console.log(`  [${m.time}] ${m.type}`);
  });

program
  .command('session-compact <name>')
  .description('Compact session')
  .option('--summary <text>', 'Custom summary')
  .action(async (name, opts) => {
    const r = await api('/session/compact', 'POST', { name, summary: opts.summary });
    if (r.ok) console.log('Compacted.');
    else console.error(`Failed: ${r.error}`);
  });

// Agent management
program
  .command('agents-list')
  .description('List agents')
  .option('-d, --cwd <dir>')
  .action(async (opts) => {
    const q = opts.cwd ? `?cwd=${encodeURIComponent(opts.cwd)}` : '';
    const r = await api(`/agents${q}`);
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      return;
    }
    const agents = r.agents as Array<{ name: string; description: string }>;
    if (!agents.length) {
      console.log('No agents found.');
      return;
    }
    for (const a of agents) console.log(`  ${a.name}${a.description ? ` — ${a.description}` : ''}`);
  });

program
  .command('agents-create <name>')
  .description('Create agent')
  .option('-d, --cwd <dir>')
  .option('--description <desc>')
  .option('--prompt <prompt>')
  .action(async (name, opts) => {
    const r = await api('/agents/create', 'POST', {
      name,
      cwd: opts.cwd,
      description: opts.description,
      prompt: opts.prompt,
    });
    if (r.ok) console.log(`Agent '${name}' created at: ${r.path}`);
    else console.error(`Failed: ${r.error}`);
  });

// Skills
program
  .command('skills-list')
  .description('List skills')
  .option('-d, --cwd <dir>')
  .action(async (opts) => {
    const q = opts.cwd ? `?cwd=${encodeURIComponent(opts.cwd)}` : '';
    const r = await api(`/skills${q}`);
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      return;
    }
    const skills = r.skills as Array<{ name: string; description: string }>;
    if (!skills.length) {
      console.log('No skills found.');
      return;
    }
    for (const s of skills) console.log(`  ${s.name}${s.description ? ` — ${s.description}` : ''}`);
  });

program
  .command('skills-create <name>')
  .description('Create skill')
  .option('-d, --cwd <dir>')
  .option('--description <desc>')
  .option('--prompt <prompt>')
  .option('--trigger <t>')
  .action(async (name, opts) => {
    const r = await api('/skills/create', 'POST', {
      name,
      cwd: opts.cwd,
      description: opts.description,
      prompt: opts.prompt,
      trigger: opts.trigger,
    });
    if (r.ok) console.log(`Skill '${name}' created at: ${r.path}`);
    else console.error(`Failed: ${r.error}`);
  });

// Rules
program
  .command('rules-list')
  .description('List rules')
  .option('-d, --cwd <dir>')
  .action(async (opts) => {
    const q = opts.cwd ? `?cwd=${encodeURIComponent(opts.cwd)}` : '';
    const r = await api(`/rules${q}`);
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      return;
    }
    const rules = r.rules as Array<{ name: string; description: string; paths: string; condition: string }>;
    if (!rules.length) {
      console.log('No rules found.');
      return;
    }
    for (const rule of rules) {
      let info = `  ${rule.name}`;
      if (rule.description) info += ` — ${rule.description}`;
      if (rule.paths) info += ` [paths: ${rule.paths}]`;
      if (rule.condition) info += ` [if: ${rule.condition}]`;
      console.log(info);
    }
  });

program
  .command('rules-create <name>')
  .description('Create rule')
  .option('-d, --cwd <dir>')
  .option('--description <desc>')
  .option('--content <text>')
  .option('--paths <glob>')
  .option('--condition <expr>')
  .action(async (name, opts) => {
    const r = await api('/rules/create', 'POST', {
      name,
      cwd: opts.cwd,
      description: opts.description,
      content: opts.content,
      paths: opts.paths,
      condition: opts.condition,
    });
    if (r.ok) console.log(`Rule '${name}' created at: ${r.path}`);
    else console.error(`Failed: ${r.error}`);
  });

// Agent teams
program
  .command('session-team-list <name>')
  .description('List teammates')
  .action(async (name) => {
    const r = await api('/session/team-list', 'POST', { name });
    if (r.ok) console.log(r.response || 'No team info');
    else console.error(`Failed: ${r.error}`);
  });

program
  .command('session-team-send <name> <teammate> <message>')
  .description('Message teammate')
  .action(async (name, teammate, message) => {
    const r = await api('/session/team-send', 'POST', { name, teammate, message });
    if (r.ok) console.log(r.output || 'Sent');
    else console.error(`Failed: ${r.error}`);
  });

program.parse();
