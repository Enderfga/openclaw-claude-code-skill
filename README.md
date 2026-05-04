<p align="center">
  <img src="assets/banner.jpg" alt="openclaw-claude-code banner" width="100%">
</p>

# openclaw-claude-code

Programmable bridge that turns coding CLIs into headless, agentic engines — persistent sessions, multi-engine orchestration, multi-agent council, and dynamic runtime control.

[![npm version](https://img.shields.io/npm/v/@enderfga/openclaw-claude-code.svg)](https://www.npmjs.com/package/@enderfga/openclaw-claude-code)
[![CI](https://github.com/Enderfga/openclaw-claude-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Enderfga/openclaw-claude-code/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-300%20passed-brightgreen)](https://github.com/Enderfga/openclaw-claude-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Why This Exists

Claude Code and Codex are powerful coding CLIs, but they're designed for interactive use. If you want AI agents to **programmatically** drive coding sessions — start them, send tasks, manage context, coordinate teams, switch models mid-conversation — you need a control layer.

This project wraps coding CLIs and exposes their capabilities as a clean, tool-based API. Your agents get persistent sessions, real-time streaming, multi-model routing, multi-engine support, and multi-agent council orchestration.

> **Why not just use the Claude API directly?** The API gives you completions. This gives you a fully managed coding agent — file editing, tool use, git awareness, context management, and multi-turn conversations — all without building the orchestration yourself.

## Quick Start

**One-line install** (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/Enderfga/openclaw-claude-code/main/install.sh | bash
```

This installs via npm, registers the plugin in `openclaw.json`, and restarts the gateway automatically.

**Standalone** (no OpenClaw):

```bash
npm install -g @enderfga/openclaw-claude-code
claude-code-skill serve
```

```typescript
import { SessionManager } from '@enderfga/openclaw-claude-code';

const manager = new SessionManager();
await manager.startSession({ name: 'task', cwd: '/project' });
const result = await manager.sendMessage('task', 'Fix the failing tests');
```

See [Getting Started](./skills/references/getting-started.md) for full setup guide.

## Features

### Multi-Engine Sessions

Drive Claude Code, OpenAI Codex, Google Gemini, Cursor Agent, or **any custom coding CLI** through a unified `ISession` interface. Each engine manages its own subprocess, events, and cost tracking.

```typescript
// Claude Code engine (default)
await manager.startSession({ name: 'claude-task', engine: 'claude', model: 'opus' });

// Codex engine
await manager.startSession({ name: 'codex-task', engine: 'codex', model: 'gpt-5.4' });

// Gemini engine
await manager.startSession({ name: 'gemini-task', engine: 'gemini', model: 'gemini-3.1-pro-preview' });

// Cursor Agent engine
await manager.startSession({ name: 'cursor-task', engine: 'cursor', model: 'sonnet-4' });

// Custom engine — any coding agent CLI via config
await manager.startSession({
  name: 'my-task',
  engine: 'custom',
  cwd: '/project',
  customEngine: {
    name: 'my-agent',
    bin: 'my-agent',
    persistent: true,  // or false for one-shot
    args: { print: '-p', outputFormat: '--output-format', outputFormatValue: 'stream-json', /* ... */ },
  },
});
```

See [Multi-Engine](./skills/references/multi-engine.md) for architecture and adding new engines.

### Multi-Agent Council

Multiple agents collaborate in parallel on the same codebase with git worktree isolation, consensus voting, and a two-phase protocol (plan then execute).

```typescript
const session = manager.councilStart('Build a REST API with auth', {
  agents: [
    { name: 'Planner', emoji: '🟠', persona: 'Requirements & architecture', engine: 'claude', model: 'opus' },
    { name: 'Generator', emoji: '🟢', persona: 'Implementation per plan', engine: 'codex', model: 'gpt-5.4' },
    { name: 'Evaluator', emoji: '🔵', persona: 'Independent verification', engine: 'claude', model: 'sonnet' },
  ],
  maxRounds: 10,
  projectDir: '/tmp/api-project',
});
```

See [Council](./skills/references/council.md) for the full collaboration protocol.

### 27 Tools

| Category | Tools |
|----------|-------|
| Session Lifecycle | `claude_session_start`, `send`, `stop`, `list`, `overview` |
| Session Operations | `status`, `grep`, `compact`, `update_tools`, `switch_model` |
| Inbox | `session_send_to`, `session_inbox`, `session_deliver_inbox` |
| Agent Teams | `agents_list`, `team_list`, `team_send` |
| Council | `council_start`, `council_status`, `council_abort`, `council_inject`, `council_review`, `council_accept`, `council_reject` |
| Ultraplan | `ultraplan_start`, `ultraplan_status` |
| Ultrareview | `ultrareview_start`, `ultrareview_status` |

See [Tools Reference](./skills/references/tools.md) for complete API.

### Session Inbox

Cross-session messaging: sessions can send messages to each other. Idle sessions receive immediately; busy sessions queue for later delivery.

```typescript
await manager.sessionSendTo('planner', 'coder', 'The auth module needs rate limiting');
await manager.sessionSendTo('monitor', '*', 'Build failed!');  // broadcast
```

### Ultraplan

Dedicated Opus planning session that explores your project for up to 30 minutes and produces a detailed implementation plan.

```typescript
const plan = manager.ultraplanStart('Add OAuth2 support with Google and GitHub providers', {
  cwd: '/project',
});
// Poll: manager.ultraplanStatus(plan.id)
```

### Ultrareview

Fleet of 5-20 bug-hunting agents that review your codebase in parallel, each from a different angle (security, performance, logic, types, etc.).

```typescript
const review = manager.ultrareviewStart('/project', {
  agentCount: 10,
  maxDurationMinutes: 15,
});
// Poll: manager.ultrareviewStatus(review.id)
```

### OpenAI-Compatible API

Drop-in backend for any OpenAI-compatible webchat frontend. Stateful sessions maximize Anthropic prompt caching (90% discount on cached tokens).

```bash
# Start the server
claude-code-skill serve

# Use with any OpenAI client
curl http://127.0.0.1:18796/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

Works with ChatGPT-Next-Web, Open WebUI, LobeChat, and any app that speaks the OpenAI API format. Set the API base URL to `http://127.0.0.1:18796/v1` and use any API key (or leave blank).

See [CLI Reference](./skills/references/cli.md) for configuration options.

### And More

- **Session Persistence** — 7-day disk TTL, auto-resume across restarts
- **Multi-Model Proxy** — Anthropic ↔ OpenAI format translation for Gemini/GPT
- **Cost Tracking** — per-model pricing with real-time token accounting
- **Effort Control** — `low` to `max` thinking depth per message
- **Runtime Model/Tool Switching** — hot-swap via `--resume`

## Architecture

```mermaid
graph TD
    A[OpenClaw / Your Code] -->|tool calls| B[Plugin Entry<br/>index.ts]
    B --> C[SessionManager]
    C --> D[Claude Engine<br/>persistent-session.ts]
    C --> E[Codex Engine<br/>persistent-codex-session.ts]
    C --> K[Gemini Engine<br/>persistent-gemini-session.ts]
    C --> L[Cursor Engine<br/>persistent-cursor-session.ts]
    C --> M[Custom Engine<br/>persistent-custom-session.ts]
    C --> F[Council<br/>council.ts]
    C --> G[Inbox / Ultraplan / Ultrareview]
    F -->|git worktree per agent| D
    B --> H[Proxy Handler]
    H -->|Anthropic format| I[Gemini / GPT / Gateway]
    B --> J[Embedded HTTP Server]
```

```
src/
├── index.ts                    # Plugin entry — 27 tools + proxy route
├── models.ts                   # Centralized model registry (pricing, aliases, engines)
├── types.ts                    # Shared types, ISession interface, re-exports from models
├── constants.ts                # Shared constants (timeouts, limits, thresholds)
├── logger.ts                   # Structured Logger interface + console implementation
├── base-oneshot-session.ts     # Abstract base class for one-shot engines (Codex/Gemini/Cursor)
├── persistent-session.ts       # Claude Code engine (ISession)
├── persistent-codex-session.ts # Codex engine (extends BaseOneShotSession)
├── persistent-gemini-session.ts # Gemini engine (extends BaseOneShotSession)
├── persistent-cursor-session.ts # Cursor Agent engine (extends BaseOneShotSession)
├── persistent-custom-session.ts # Custom engine — any CLI via config (ISession)
├── session-manager.ts          # Multi-session orchestration + council management
├── circuit-breaker.ts          # Engine failure tracking with exponential backoff
├── inbox-manager.ts            # Cross-session messaging (inbox)
├── council.ts                  # Multi-agent council orchestration
├── consensus.ts                # Consensus vote parsing
├── openai-compat.ts            # OpenAI-compatible /v1/chat/completions
├── embedded-server.ts          # HTTP server for standalone mode
└── proxy/
    ├── handler.ts              # Provider detection + routing
    ├── anthropic-adapter.ts    # Anthropic ↔ OpenAI conversion
    ├── schema-cleaner.ts       # Gemini schema compatibility
    └── thought-cache.ts        # Gemini thought caching

skills/
├── SKILL.md                    # OpenClaw skill definition (triggers + metadata)
└── references/                 # All documentation (progressive disclosure)
    ├── getting-started.md      # Installation, configuration, first session
    ├── sessions.md             # Persistent sessions, resume, cost tracking
    ├── multi-engine.md         # Claude + Codex + Gemini + Cursor + Custom engines
    ├── council.md              # Multi-agent collaboration protocol
    ├── tools.md                # Complete 27-tool API reference
    ├── inbox.md                # Cross-session messaging
    ├── ultra.md                # Ultraplan & Ultrareview
    └── cli.md                  # Command-line interface
```

## Documentation

All documentation lives in [`skills/references/`](./skills/references/) — see the directory tree above. Start with [Getting Started](./skills/references/getting-started.md), or jump to the [Tools Reference](./skills/references/tools.md) for the full 27-tool API.

For contributing: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Engine Compatibility

All engines are tested and verified in each release:

| Engine | CLI | Tested Version | Invocation | Status |
|--------|-----|---------------|------------|--------|
| Claude Code | `claude` | 2.1.121 | Persistent subprocess, stream-json | **Fully supported** |
| OpenAI Codex | `codex` | 0.128.0 | `codex exec --sandbox workspace-write --json`, per-message; or `codex app-server` (long-running, for `/goal`) | **Fully supported** |
| Google Gemini | `gemini` | 0.36.0 | `gemini -p --output-format stream-json`, per-message | **Fully supported** |
| Cursor Agent | `agent` | 2026.03.30 | `agent -p --force --output-format stream-json`, per-message | **Fully supported** |
| Custom | User-configured | Any | User-defined via `CustomEngineConfig` | **Fully supported** |

> **Note:** CLI versions evolve independently. If a new CLI version changes its flags or output format, the plugin may need an update. Pin your CLI versions in CI to avoid surprises.

### Known Limitations

- **Team tools** (`team_list`, `team_send`) work on all engines via cross-session inbox routing as a virtual team layer. Claude Code's native experimental Agent Teams is an in-process TUI mechanism and is not reachable from a subprocess wrapper
- **Codex/Gemini/Cursor sessions** are one-shot per message (no persistent subprocess) — context is carried via working directory, not conversation history
- **Custom engine** event parsing assumes stream-json NDJSON format compatible with Claude Code / Gemini / Cursor CLI output; CLIs with proprietary output formats may need a built-in engine instead
- **Council consensus** requires agents to output an explicit `[CONSENSUS: YES/NO]` tag — loose phrasing will default to NO
- **Inbox delivered messages** are not retained in inbox history (only queued messages appear)

## Requirements

- **Node.js >= 22**
- **Claude Code CLI >= 2.1** — `npm install -g @anthropic-ai/claude-code`
- **OpenClaw >= 2026.3.0** (optional, for plugin mode)
- **Codex CLI >= 0.112** (optional) — `npm install -g @openai/codex`
- **Gemini CLI >= 0.35** (optional) — `npm install -g @google/gemini-cli`
- **Cursor Agent CLI** (optional) — Install via Cursor IDE or `curl https://cursor.com/install -fsSL | bash`

## License

MIT
