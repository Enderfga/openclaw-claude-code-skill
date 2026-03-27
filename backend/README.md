# claude-code-backend

HTTP API server that wraps the Claude Code CLI, enabling `claude-code-skill` to drive persistent sessions programmatically.

## Architecture

```
claude-code-skill CLI  ──HTTP──►  backend (:18795)  ──spawn──►  claude (CLI)
```

The backend manages named sessions in-process. Each session tracks conversation history, token usage, hooks, and model config. Claude Code is driven via `claude -p --output-format stream-json`.

## Requirements

- Node.js 18+
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and on `$PATH` as `claude`
- `ANTHROPIC_API_KEY` set in environment

## Installation

```bash
cd backend
npm install
npm run build
```

## Running

```bash
# Foreground
./start.sh

# Daemon (background)
./start.sh --daemon

# Stop daemon
./stop.sh
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Your Anthropic API key (required) |
| `CLAUDE_BIN` | `claude` | Path/name of the Claude Code CLI binary |
| `BACKEND_API_PORT` | `18795` | Port to listen on |

The server binds to `127.0.0.1` only (local access).

### Amazon Bedrock Support

If you are using Amazon Bedrock instead of an Anthropic API key, set the following environment variables (e.g., in a `.env` file in the `backend/` directory):

```ini
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-east-1
ANTHROPIC_MODEL=global.anthropic.claude-sonnet-4-6
ANTHROPIC_DEFAULT_SONNET_MODEL=us.anthropic.claude-sonnet-4-6
ANTHROPIC_DEFAULT_OPUS_MODEL=us.anthropic.claude-opus-4-6-v1
```

## API

All routes are prefixed with `/backend-api/claude-code`.

### Connection

| Method | Path | Description |
|---|---|---|
| POST | `/connect` | Mark as connected, returns tool count |
| POST | `/disconnect` | Mark as disconnected |
| GET | `/tools` | List available tools |

### Sessions

| Method | Path | Description |
|---|---|---|
| POST | `/session/start` | Create a new named session |
| POST | `/session/send` | Send a message (blocking) |
| POST | `/session/send-stream` | Send a message (SSE streaming) |
| POST | `/session/stop` | Delete session |
| POST | `/session/status` | Session stats |
| GET | `/session/list` | List active sessions |
| POST | `/session/history` | Conversation history |
| POST | `/session/pause` | Pause session |
| POST | `/session/resume` | Resume paused session |
| POST | `/session/fork` | Fork session |
| POST | `/session/branch` | Fork + change model/effort |
| POST | `/session/compact` | Compact context window |
| POST | `/session/context` | Token usage + suggestions |
| POST | `/session/model` | Switch model mid-session |
| POST | `/session/effort` | Change effort level |
| POST | `/session/cost` | Cost breakdown |
| POST | `/session/hooks` | Register/list webhook callbacks |
| POST | `/session/restart` | Restart failed session |
| POST | `/session/search` | Search sessions by query/project/time |

### Direct Tools

| Method | Path | Description |
|---|---|---|
| POST | `/bash` | Run a bash command via Claude |
| POST | `/read` | Read a file directly |
| POST | `/call` | Call any Claude Code tool |
| POST | `/batch-read` | Read multiple files by glob |
| POST | `/resume` | Resume a claude session by ID |
| POST | `/continue` | Continue the last claude session |
| GET | `/sessions` | List all claude session files |

### Session Start Payload

```json
{
  "name": "myproject",
  "cwd": "/path/to/project",
  "permissionMode": "acceptEdits",
  "model": "claude-opus-4-6",
  "effort": "high",
  "allowedTools": ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  "maxBudgetUsd": 5.0,
  "appendSystemPrompt": "Always write tests.",
  "dangerouslySkipPermissions": false
}
```

### Session Send Payload

```json
{
  "name": "myproject",
  "message": "Refactor the auth module",
  "effort": "high",
  "plan": false,
  "timeout": 600000
}
```

### Streaming (SSE)

`/session/send-stream` returns Server-Sent Events:

```
data: {"type":"text","text":"Let me analyze..."}
data: {"type":"tool_use","tool":"Bash","input":"npm test"}
data: {"type":"tool_result"}
data: {"type":"done","text":"All tests pass.","stop_reason":"end_turn"}
```

### Hooks (Webhooks)

```json
{
  "name": "myproject",
  "hooks": {
    "onToolError": "http://localhost:8080/webhook",
    "onContextHigh": "http://localhost:8080/webhook",
    "onStop": "http://localhost:8080/webhook",
    "onTurnComplete": "http://localhost:8080/webhook",
    "onStopFailure": "http://localhost:8080/webhook"
  }
}
```

Payload format:

```json
{
  "hook": "onToolError",
  "session": "myproject",
  "data": { "tool": "Bash", "error": "command not found" },
  "timestamp": "2026-03-27T09:00:00.000Z"
}
```

## Development

```bash
npm run dev   # run with tsx (no build step)
npm run build # compile TypeScript → dist/
```
