---
name: claw-orchestrator
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
              "package": "@enderfga/claw-orchestrator",
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

# Claw Orchestrator Skill

Claw Orchestrator — persistent multi-engine coding session manager for claw-style agent systems. Runs as a standalone CLI/server, with first-class OpenClaw plugin support. Wraps Claude Code, Codex, Gemini, Cursor Agent, and custom CLIs into headless agentic engines with 35 tools.

## Engine Quick Reference

| Engine | CLI | Session Type | Best For |
|--------|-----|-------------|----------|
| `claude` | `claude` | Persistent subprocess | Multi-turn, complex tasks |
| `codex` | `codex exec` | Per-message spawn | One-shot execution |
| `gemini` | `gemini -p` | Per-message spawn | One-shot execution |
| `cursor` | `agent -p` | Per-message spawn | One-shot execution |

## Core Workflow

```javascript
// 1. Start session (any engine)
claude_session_start({ name: "myproject", cwd: "/path/to/project", engine: "claude" })
claude_session_start({ name: "codex-task", cwd: "/path/to/project", engine: "codex" })
claude_session_start({ name: "gemini-task", cwd: "/path/to/project", engine: "gemini" })
claude_session_start({ name: "cursor-task", cwd: "/path/to/project", engine: "cursor" })

// 2. Send messages
claude_session_send({ name: "myproject", message: "Fix the auth bug" })

// 3. Check status / search history
claude_session_status({ name: "myproject" })
claude_session_grep({ name: "myproject", pattern: "error" })

// 4. Stop when done
claude_session_stop({ name: "myproject" })
```

## Session Options

| Parameter | Description |
|-----------|-------------|
| `engine` | `claude` (default), `codex`, `gemini`, `cursor` |
| `model` | Model name or alias (`opus`, `sonnet`, `haiku`, `gpt-5.4`, `gemini-pro`, `composer-2`) |
| `permissionMode` | `acceptEdits`, `auto`, `plan`, `bypassPermissions`, `default` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max`, `auto` (`xhigh` is Opus 4.7-only, between `high` and `max`) |
| `maxBudgetUsd` | Cost limit in USD |
| `allowedTools` | List of allowed tool names |

### CLI 2.1.111 options

| Parameter | Description |
|-----------|-------------|
| `bare` | Minimal mode — no CLAUDE.md, hooks, LSP, auto-memory. Auto-enables prompt cache optimizations (see below). |
| `includeHookEvents` | Stream hook lifecycle events (PreToolUse/PostToolUse). |
| `permissionPromptTool` | Delegate permission prompts to an MCP tool for non-interactive use. |
| `excludeDynamicSystemPromptSections` | Move cwd/env/git from system prompt to user message for better prompt cache hits. Auto-enabled with `bare: true`. |
| `enablePromptCaching1H` | Enable 1-hour prompt cache TTL (vs default 5-min). Auto-enabled with `bare: true`. |
| `debug` / `debugFile` | Targeted debug output by category (e.g. `"api,mcp"`) and optional file path. |
| `fromPr` | Resume a session linked to a GitHub PR number or URL. |
| `channels` / `dangerouslyLoadDevelopmentChannels` | MCP channel subscriptions (research preview). |

### CLI 2.1.121 options

| Parameter | Description |
|-----------|-------------|
| `forkSubagent` | Fork subagent for non-interactive sessions (sets `CLAUDE_CODE_FORK_SUBAGENT=1`). |
| `enableToolSearch` | Enable Vertex AI tool search (sets `ENABLE_TOOL_SEARCH=1`). |
| `otelLogUserPrompts` | OpenTelemetry: include user prompts in logs (sets `OTEL_LOG_USER_PROMPTS=1`). |
| `otelLogRawApiBodies` | OpenTelemetry: include raw API bodies in logs (sets `OTEL_LOG_RAW_API_BODIES=1`). Debug only. |

`stats.pluginErrors` is now populated from the `system/init` event when CLI plugins fail to load due to unmet dependencies.

`TRACEPARENT` / `TRACESTATE` (W3C distributed tracing) are automatically forwarded from parent process env — set them before starting the session and they propagate to the child Claude CLI.

**Smart defaults:** When `bare: true`, the plugin auto-enables `--exclude-dynamic-system-prompt-sections` and `ENABLE_PROMPT_CACHING_1H=1` unless explicitly set to `false`.

## Multi-Agent Council

Parallel agent collaboration with git worktree isolation and consensus voting. Agents can use different engines.

```javascript
// Start a council
council_start({
  task: 'Build a REST API',
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

```javascript
claude_session_send_to({ from: "sender", to: "receiver", message: "Auth module needs rate limiting" })
claude_session_send_to({ from: "monitor", to: "*", message: "Build failed!" })  // broadcast
claude_session_inbox({ name: "receiver" })
claude_session_deliver_inbox({ name: "receiver" })
```

## Team Tools (All Engines)

All engines use the same virtual-team layer: cross-session inbox routing across active SessionManager sessions. (Claude Code's native experimental Agent Teams is in-process TUI only and not reachable from a subprocess wrapper.)

```javascript
claude_team_list({ name: "myproject" })
claude_team_send({ name: "myproject", teammate: "teammate", message: "Review this" })
```

## Ultraplan & Ultrareview

- **Ultraplan**: Opus deep planning session (up to 30 min), produces detailed implementation plan
- **Ultrareview**: Fleet of 5-20 bug-hunting agents reviewing in parallel (security, logic, perf, types, etc.)

Both are async — start then poll status.

## 27 Tools Overview

| Category | Tools |
|----------|-------|
| Session Lifecycle | `claude_session_start`, `claude_session_send`, `claude_session_stop`, `claude_session_list`, `claude_sessions_overview` |
| Session Ops | `claude_session_status`, `claude_session_grep`, `claude_session_compact`, `claude_session_update_tools`, `claude_session_switch_model` |
| Inbox | `claude_session_send_to`, `claude_session_inbox`, `claude_session_deliver_inbox` |
| Teams | `claude_agents_list`, `claude_team_list`, `claude_team_send` |
| Council | `council_start`, `council_status`, `council_abort`, `council_inject`, `council_review`, `council_accept`, `council_reject` |
| Ultra | `ultraplan_start`, `ultraplan_status`, `ultrareview_start`, `ultrareview_status` |

For full parameter reference: see [references/tools.md](references/tools.md)

## Authentication Prerequisites

Each engine requires its own auth before use:

- **Claude**: `claude /login` or `ANTHROPIC_API_KEY`
- **Codex**: `codex login` or `OPENAI_API_KEY`
- **Gemini**: `gemini login` or `GEMINI_API_KEY`
- **Cursor**: `agent login` or `CURSOR_API_KEY`
