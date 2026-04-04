# Tools Reference

All tools are registered as OpenClaw plugin tools. In standalone mode, they're accessible via the embedded HTTP server.

## Session Lifecycle (5)

### `claude_session_start`

Start a persistent coding session with full CLI flag support.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Session name (auto-generated if omitted) |
| `cwd` | string | Working directory |
| `engine` | `'claude'` \| `'codex'` \| `'gemini'` \| `'cursor'` | Engine to use (default: `claude`) |
| `model` | string | Model alias or full name |
| `permissionMode` | string | `acceptEdits`, `bypassPermissions`, `plan`, `auto`, `default` |
| `effort` | string | `low`, `medium`, `high`, `max`, `auto` |
| `allowedTools` | string[] | Tools to auto-approve |
| `disallowedTools` | string[] | Tools to deny |
| `maxTurns` | number | Max agent loop turns |
| `maxBudgetUsd` | number | Max API spend (USD) |
| `systemPrompt` | string | Replace system prompt |
| `appendSystemPrompt` | string | Append to system prompt |
| `agents` | object | Custom sub-agents JSON |
| `agent` | string | Default agent to use |
| `bare` | boolean | Skip hooks, LSP, auto-memory, CLAUDE.md |
| `worktree` | string \| boolean | Run in git worktree |
| `fallbackModel` | string | Fallback when primary overloaded |
| `resumeSessionId` | string | Resume existing session by ID |
| `jsonSchema` | string | JSON Schema for structured output |
| `mcpConfig` | string \| string[] | MCP server config file(s) |
| `settings` | string | Settings.json path or inline JSON |
| `noSessionPersistence` | boolean | Do not save session to disk |
| `betas` | string \| string[] | Custom beta headers |
| `enableAgentTeams` | boolean | Enable experimental agent teams |
| `enableAutoMode` | boolean | Enable auto permission mode |

### `claude_session_send`

Send a message and get the response.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name |
| `message` | string | yes | Message to send |
| `effort` | string | | Override effort for this message |
| `plan` | boolean | | Enable plan mode |
| `timeout` | number | | Timeout in ms (default 300000) |
| `stream` | boolean | | Collect streaming chunks in result |

### `claude_session_stop`

Graceful shutdown (SIGTERM, then SIGKILL after 3s).

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

### `claude_session_list`

List all active and persisted sessions. No parameters.

### `claude_sessions_overview`

Dashboard view: all sessions with ready/busy/paused state, cost, context %, last activity. No parameters.

---

## Session Operations (5)

### `claude_session_status`

Detailed status: tokens, cost, context %, tool calls, uptime.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

### `claude_session_grep`

Regex search over session event history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name |
| `pattern` | string | yes | Regex pattern |
| `limit` | number | | Max results (default 50) |

### `claude_session_compact`

Reclaim context window via `/compact`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `summary` | string | |

### `claude_session_update_tools`

Update tool permissions at runtime. Restarts session with `--resume`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Session name |
| `allowedTools` | string[] | New allowed tools (replaces or merges) |
| `disallowedTools` | string[] | New disallowed tools |
| `removeTools` | string[] | Tools to remove from lists |
| `merge` | boolean | Merge with existing (default: replace) |

### `claude_session_switch_model`

Hot-swap model mid-conversation. Restarts with `--resume`.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `model` | string | yes |

---

## Agent Teams (3)

### `claude_agents_list`

List agent definitions from `.claude/agents/` (project + global).

| Parameter | Type |
|-----------|------|
| `cwd` | string |

### `claude_team_list`

List teammates in an agent team session.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

### `claude_team_send`

Send message to a specific teammate.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |
| `teammate` | string | yes |
| `message` | string | yes |

---

## Council (7)

### `council_start`

Start a multi-agent council. Runs in background, returns session ID immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | Task description |
| `projectDir` | string | yes | Working directory |
| `agents` | AgentPersona[] | | Agent list (defaults to 3-agent team) |
| `maxRounds` | number | | Max rounds (default 15) |
| `agentTimeoutMs` | number | | Per-agent timeout (default 1800000) |
| `maxTurnsPerAgent` | number | | Max tool turns per agent (default 30) |
| `maxBudgetUsd` | number | | Max API spend per agent |

### `council_status`

Get status of a running or recently completed council.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `council_abort`

Abort a running council, stopping all agent sessions.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

### `council_inject`

Inject a user message into the next round of a running council.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
| `message` | string | yes |

### `council_review`

Review a completed council session. Returns a structured report of all changed files, branches, worktrees, plan.md status, review files, and agent summaries. Does not modify any state.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

**Returns**: `CouncilReviewResult` with `changedFiles`, `branches`, `worktrees`, `reviews`, `planContent`, and `agentSummaries`.

### `council_accept`

Accept and finalize council work. Cleans up all council scaffolding: removes worktrees, deletes `council/*` branches, removes `plan.md` and `reviews/` directory.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

**Returns**: `CouncilAcceptResult` with `branchesDeleted`, `worktreesRemoved`, `planDeleted`, `reviewsDeleted`.

### `council_reject`

Reject council work and provide feedback. Rewrites `plan.md` with rejection feedback and commits it. Does NOT delete any worktrees or branches — the council can be restarted to retry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Council session ID |
| `feedback` | string | yes | Detailed feedback on what needs to be fixed |

**Returns**: `CouncilRejectResult` with `planRewritten` and `feedback`.

---

## Inbox (3)

### `claude_session_send_to`

Send a cross-session message. Delivered immediately if target is idle, queued if busy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Sender session name |
| `to` | string | yes | Target session name, or `"*"` for broadcast |
| `message` | string | yes | Message text |
| `summary` | string | | Short preview (5-10 words) |

### `claude_session_inbox`

Read inbox messages for a session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Session name |
| `unreadOnly` | boolean | | Only unread (default true) |

### `claude_session_deliver_inbox`

Deliver all queued inbox messages to an idle session.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | yes |

---

## Ultraplan (2)

### `ultraplan_start`

Start a dedicated Opus planning session (up to 30 min). Runs in background.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | yes | What to plan |
| `cwd` | string | | Project directory |
| `model` | string | | Model (default: opus) |
| `timeout` | number | | Timeout ms (default 1800000) |

### `ultraplan_status`

Get status and plan text when completed.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |

---

## Ultrareview (2)

### `ultrareview_start`

Launch a fleet of bug-hunting agents (1-20) reviewing code from different angles.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | yes | Project directory |
| `agentCount` | number | | Agents (1-20, default 5) |
| `maxDurationMinutes` | number | | Duration (5-25 min, default 10) |
| `model` | string | | Model for reviewers |
| `focus` | string | | Review focus area |

### `ultrareview_status`

Get status and findings when completed.

| Parameter | Type | Required |
|-----------|------|----------|
| `id` | string | yes |
