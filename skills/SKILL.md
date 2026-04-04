---
name: claude-code-skill
description: Manage persistent coding sessions across Claude Code, Codex, Gemini, and Cursor engines. Use when orchestrating multi-engine coding agents, starting/sending/stopping sessions, running multi-agent council collaborations, cross-session messaging, ultraplan deep planning, ultrareview parallel code review, or switching models/tools at runtime. Triggers on "start a session", "send to session", "run council", "ultraplan", "ultrareview", "switch model", "multi-agent", "coding session", "session inbox", "cursor agent".
metadata:
  {
    "openclaw":
      {
        "emoji": "🤖",
        "requires": { "anyBins": ["claude", "codex", "gemini", "agent"] },
        "install":
          [
            {
              "id": "npm-plugin",
              "kind": "node",
              "package": "@enderfga/openclaw-claude-code",
              "label": "Install plugin (npm)"
            },
            {
              "id": "node-claude",
              "kind": "node",
              "package": "@anthropic-ai/claude-code",
              "bins": ["claude"],
              "label": "Install Claude Code CLI"
            },
            {
              "id": "node-codex",
              "kind": "node",
              "package": "@openai/codex",
              "bins": ["codex"],
              "label": "Install Codex CLI"
            },
            {
              "id": "node-gemini",
              "kind": "node",
              "package": "@google/gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI"
            }
          ]
      }
  }
---

# Claude Code Skill

Persistent multi-engine coding session manager. Wraps Claude Code, Codex, Gemini, and Cursor CLIs into headless agentic engines with 27 tools.

## Engine Quick Reference

| Engine | CLI | Session Type | Best For |
|--------|-----|-------------|----------|
| `claude` | `claude` | Persistent subprocess | Multi-turn, complex tasks |
| `codex` | `codex exec` | Per-message spawn | One-shot execution |
| `gemini` | `gemini -p` | Per-message spawn | One-shot execution |
| `cursor` | `agent -p` | Per-message spawn | One-shot execution |

## Core Workflow

```bash
# 1. Start session (any engine)
claude-code-skill session-start myproject -d /path/to/project --engine claude
claude-code-skill session-start codex-task -d /path/to/project --engine codex
claude-code-skill session-start gemini-task -d /path/to/project --engine gemini
claude-code-skill session-start cursor-task -d /path/to/project --engine cursor

# 2. Send messages
claude-code-skill session-send myproject "Fix the auth bug" --stream

# 3. Check status / search history
claude-code-skill session-status myproject
claude-code-skill session-grep myproject "error"

# 4. Stop when done
claude-code-skill session-stop myproject
```

## Session Options

| Option | Description |
|--------|-------------|
| `--engine` | `claude` (default), `codex`, `gemini`, `cursor` |
| `--model` | Model name or alias (`opus`, `sonnet`, `haiku`, `o4-mini`, `gemini-pro`, `sonnet-4`) |
| `--permission-mode` | `acceptEdits`, `auto`, `plan`, `bypassPermissions`, `default` |
| `--effort` | `low`, `medium`, `high`, `max`, `auto` |
| `--max-budget` | Cost limit in USD |
| `--allowed-tools` | Comma-separated tool whitelist |
| `--stream` | Real-time streaming output |

## Multi-Agent Council

Parallel agent collaboration with git worktree isolation and consensus voting. Agents can use different engines.

```bash
# Via TypeScript SDK
manager.councilStart('Build a REST API', {
  agents: [
    { name: 'Architect', emoji: '🏗️', persona: 'System design', engine: 'claude' },
    { name: 'Engineer', emoji: '⚙️', persona: 'Implementation', engine: 'codex' },
  ],
  maxRounds: 5,
  projectDir: '/path/to/project',
});
```

Council lifecycle: `council_start` → poll `council_status` → `council_review` → `council_accept` or `council_reject`.

For details: see [references/council.md](references/council.md)

## Cross-Session Messaging

Sessions can communicate. Idle sessions receive immediately; busy sessions queue.

```bash
claude-code-skill session-send-to sender receiver "Auth module needs rate limiting"
claude-code-skill session-send-to monitor "*" "Build failed!"  # broadcast
claude-code-skill session-inbox receiver
claude-code-skill session-deliver-inbox receiver
```

## Team Tools (All Engines)

- **Claude**: native `/team` and `@teammate` commands
- **Codex/Gemini/Cursor**: virtual teams via cross-session inbox routing

```bash
claude-code-skill session-team-list myproject
claude-code-skill session-team-send myproject teammate "Review this"
```

## Ultraplan & Ultrareview

- **Ultraplan**: Opus deep planning session (up to 30 min), produces detailed implementation plan
- **Ultrareview**: Fleet of 5-20 bug-hunting agents reviewing in parallel (security, logic, perf, types, etc.)

Both are async — start then poll status.

## 27 Tools Overview

| Category | Tools |
|----------|-------|
| Session Lifecycle | `session_start`, `send`, `stop`, `list`, `overview` |
| Session Ops | `status`, `grep`, `compact`, `update_tools`, `switch_model` |
| Inbox | `send_to`, `inbox`, `deliver_inbox` |
| Teams | `agents_list`, `team_list`, `team_send` |
| Council | `start`, `status`, `abort`, `inject`, `review`, `accept`, `reject` |
| Ultra | `ultraplan_start/status`, `ultrareview_start/status` |

For full parameter reference: see [references/tools.md](references/tools.md)

## Authentication Prerequisites

Each engine requires its own auth before use:

- **Claude**: `claude /login` or `ANTHROPIC_API_KEY`
- **Codex**: `codex login` or `OPENAI_API_KEY`
- **Gemini**: `gemini login` or `GEMINI_API_KEY`
- **Cursor**: `agent login` or `CURSOR_API_KEY`
