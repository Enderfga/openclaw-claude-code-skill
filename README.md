# openclaw-claude-code

Full-featured Claude Code integration for OpenClaw — session management, agent teams, multi-model proxy, and plan mode workflows.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## What is this?

An OpenClaw native plugin that turns Anthropic's Claude Code CLI into a **programmable, headless coding engine**. Your AI agents get 10 tools to drive Claude Code sessions — start, send messages, manage context, coordinate agent teams, and more.

Works as:
- **OpenClaw Plugin** — install once, agents get `claude_session_*` tools automatically
- **Standalone CLI** — `claude-code-skill serve` + CLI commands, no OpenClaw needed
- **TypeScript library** — `import { SessionManager } from '@enderfga/openclaw-claude-code'`

## Install

### As OpenClaw Plugin

```bash
openclaw plugins install @enderfga/openclaw-claude-code
openclaw gateway restart
```

That's it. Your agents can now use `claude_session_start`, `claude_session_send`, etc.

### Standalone (no OpenClaw)

```bash
npm install -g @enderfga/openclaw-claude-code

# Start the embedded server
claude-code-skill serve

# Use CLI commands
claude-code-skill session-start myproject -d ~/project
claude-code-skill session-send myproject "fix the auth bug"
claude-code-skill session-stop myproject
```

## Tools (10)

| Tool | Description |
|------|-------------|
| `claude_session_start` | Start a session with full CLI flag support (model, effort, worktree, bare, agent teams, etc.) |
| `claude_session_send` | Send a message and get the response |
| `claude_session_stop` | Stop a session |
| `claude_session_list` | List active sessions |
| `claude_session_status` | Status with context %, tokens, cost, uptime |
| `claude_session_grep` | Search session history by regex |
| `claude_session_compact` | Compact session to reclaim context window |
| `claude_agents_list` | List agent definitions from `.claude/agents/` |
| `claude_team_list` | List teammates in an agent team session |
| `claude_team_send` | Send message to a specific teammate |

## CLI Commands

### Session Management

```bash
claude-code-skill session-start [name] [options]
claude-code-skill session-send <name> <message> [--effort high] [--plan]
claude-code-skill session-stop <name>
claude-code-skill session-list
claude-code-skill session-status <name>
claude-code-skill session-grep <name> <pattern>
claude-code-skill session-compact <name> [--summary <text>]
```

### Agent / Skill / Rule Management

```bash
claude-code-skill agents-list [-d <dir>]
claude-code-skill agents-create <name> [--description <desc>] [--prompt <prompt>]
claude-code-skill skills-list [-d <dir>]
claude-code-skill skills-create <name> [--description <desc>] [--prompt <prompt>]
claude-code-skill rules-list [-d <dir>]
claude-code-skill rules-create <name> [--paths "*.py"] [--condition "Bash(git *)"]
```

### Agent Teams

```bash
claude-code-skill session-start team -d ~/project --enable-agent-teams
claude-code-skill session-team-list <name>
claude-code-skill session-team-send <name> <teammate> <message>
```

## Session Start Flags

All Claude Code CLI flags are supported:

```bash
claude-code-skill session-start myproject \
  -d ~/project \
  -m opus \
  --effort high \
  --bare \
  --worktree \
  --fallback-model sonnet \
  --json-schema '{"type":"object","properties":{"name":{"type":"string"}}}' \
  --mcp-config ./mcp.json \
  --settings ./settings.json \
  --skip-persistence \
  --betas "max-tokens-3-5-sonnet-2024-07-15" \
  --enable-agent-teams \
  --allowed-tools Bash,Read,Edit \
  --max-turns 50 \
  --max-budget 5.00
```

## Multi-Model Proxy

Built-in Anthropic-to-OpenAI format translation. Claude Code CLI talks Anthropic format; the proxy converts to/from OpenAI format for Gemini, GPT, and other models.

- Pure TypeScript, zero Python dependency
- Streaming SSE conversion
- Gemini tool schema cleaning
- Thought signature caching (Gemini round-trip)
- Gateway passthrough mode (OpenClaw handles routing)

## Architecture

```
openclaw-claude-code/
├── src/
│   ├── index.ts                 # Plugin entry — 10 tools + hooks + proxy route
│   ├── types.ts                 # Shared types, model pricing/aliases
│   ├── persistent-session.ts    # Claude CLI subprocess management
│   ├── session-manager.ts       # Pure class, manages multiple sessions
│   ├── embedded-server.ts       # Auto-start HTTP server for CLI
│   ├── hooks/
│   │   └── prompt-bypass.ts     # Passthrough workspace hook
│   └── proxy/
│       ├── handler.ts           # HTTP route handler
│       ├── anthropic-adapter.ts # Anthropic ↔ OpenAI format conversion
│       ├── schema-cleaner.ts    # Gemini schema compatibility
│       └── thought-cache.ts     # Gemini thought signature cache
├── bin/
│   └── cli.ts                   # CLI (HTTP client to embedded server)
├── skills/
│   └── SKILL.md                 # Bundled skill for plan mode workflows
├── openclaw.plugin.json         # Plugin manifest
└── package.json
```

## Configuration (OpenClaw)

In `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-claude-code": {
        "enabled": true,
        "config": {
          "claudeBin": "claude",
          "defaultModel": "claude-opus-4-6",
          "defaultPermissionMode": "acceptEdits",
          "defaultEffort": "auto",
          "maxConcurrentSessions": 5,
          "sessionTtlMinutes": 120
        }
      }
    }
  }
}
```

## Requirements

- Node.js >= 22
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- OpenClaw >= 2026.3.0 (for plugin mode, optional)

## License

MIT
