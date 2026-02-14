# Claude Code Skill 🤖

Control Claude Code via MCP (Model Context Protocol). This CLI provides programmatic access to Claude Code's full capabilities including persistent sessions, agent teams, and advanced tool control.

## Features

- 🔌 **MCP Protocol** - Direct access to all Claude Code tools
- 💾 **Persistent Sessions** - Maintain context across multiple interactions
- 🤝 **Agent Teams** - Deploy multiple specialized agents
- 🔧 **Tool Control** - Fine-grained control over which tools are available
- 📊 **Budget Limits** - Set spending caps on API usage
- 🔄 **Session Management** - Fork, pause, resume, search sessions

## Installation

```bash
# Clone
git clone https://github.com/Enderfga/openclaw-claude-code-skill.git
cd openclaw-claude-code-skill

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

## Requirements

- Node.js 18+
- Backend API server running (see Configuration)
- Claude Code CLI (for the backend)

## Multi-Model Support (Proxy) 🌐

Use `--base-url` to route requests through a custom API endpoint, enabling **any OpenAI-compatible model** to power Claude Code:

```bash
# Use Gemini via claude-code-proxy
claude-code-skill session-start gemini-task -d ~/project \
  --model gemini-2.0-flash \
  --base-url http://127.0.0.1:8082

# Use GPT-4o via OpenAI-compatible endpoint
claude-code-skill session-start gpt-task -d ~/project \
  --model gpt-4o \
  --base-url https://api.openai.com/v1

# Use any OpenRouter model
claude-code-skill session-start mixtral-task -d ~/project \
  --model mistral/mixtral-8x7b \
  --base-url https://openrouter.ai/api/v1
```

This unlocks the full Claude Code agent loop (persistent sessions, tool use, multi-turn) with any model backend.

## Quick Start

```bash
# Start a persistent session
claude-code-skill session-start myproject -d ~/project \
  --permission-mode plan \
  --allowed-tools "Bash,Read,Edit,Write,Glob,Grep"

# Send a task
claude-code-skill session-send myproject "Find all TODO comments and fix them" --stream

# Check status
claude-code-skill session-status myproject

# Stop when done
claude-code-skill session-stop myproject
```

## Configuration

The CLI connects to a backend API server. Set the URL via environment variable:

```bash
# Default: http://127.0.0.1:18795
export BACKEND_API_URL="http://your-server:port"
# Alias also supported:
export CLAUDE_CODE_API_URL="http://your-server:port"
```

## Basic Commands

```bash
# Connection
claude-code-skill connect          # Connect to MCP server
claude-code-skill disconnect       # Disconnect
claude-code-skill status           # Check connection status
claude-code-skill tools            # List available tools

# Direct tool calls
claude-code-skill bash "npm test"
claude-code-skill read /path/to/file.ts
claude-code-skill glob "**/*.ts" -p ~/project
claude-code-skill grep "TODO" -p ~/project -c
claude-code-skill call Write -a '{"file_path":"/tmp/test.txt","content":"Hello"}'
```

## Persistent Sessions

### Start a Session

```bash
# Basic
claude-code-skill session-start myproject -d ~/project

# With custom model and API endpoint (proxy support)
claude-code-skill session-start gemini-dev -d ~/project \
  --model gemini-2.0-flash \
  --base-url http://127.0.0.1:8082

# With full options
claude-code-skill session-start advanced -d ~/project \
  --model claude-opus-4-5 \
  --permission-mode plan \
  --allowed-tools "Bash,Read,Edit,Write" \
  --max-budget 2.00 \
  --append-system-prompt "Always write tests"
```

| Option | Description |
|--------|-------------|
| `-m, --model <model>` | Model to use (e.g., `claude-opus-4-5`, `gemini-2.0-flash`) |
| `-b, --base-url <url>` | Custom API endpoint for proxy/alternative backends |

### Permission Modes

| Mode | Description |
|------|-------------|
| `acceptEdits` | Auto-accept file edits (default) |
| `plan` | Preview changes before applying |
| `default` | Ask for each operation |
| `bypassPermissions` | Skip all prompts (dangerous!) |

### Session Management

```bash
claude-code-skill session-list                    # List active sessions
claude-code-skill session-send myproject "task"   # Send message
claude-code-skill session-send myproject "task" --stream  # With streaming
claude-code-skill session-status myproject        # Get status
claude-code-skill session-history myproject -n 50 # View history
claude-code-skill session-pause myproject         # Pause session
claude-code-skill session-resume-paused myproject # Resume session
claude-code-skill session-fork myproject exp      # Fork session
claude-code-skill session-stop myproject          # Stop session
claude-code-skill session-restart myproject       # Restart failed session
```

## Agent Teams

Deploy multiple specialized agents:

```bash
claude-code-skill session-start team -d ~/project \
  --agents '{
    "architect": {"prompt": "Design system architecture"},
    "developer": {"prompt": "Implement features"},
    "reviewer": {"prompt": "Review code quality"}
  }' \
  --agent architect

# Switch agents with @mention
claude-code-skill session-send team "@developer implement the design"
claude-code-skill session-send team "@reviewer review the implementation"
```

## Tool Control

```bash
# Allow specific tools
--allowed-tools "Bash(git:*,npm:*),Read,Edit"

# Deny dangerous operations
--disallowed-tools "Bash(rm:*,sudo:*),Write(/etc/*)"

# Limit available tools
--tools "Read,Glob,Grep"
```

## Session Search

```bash
claude-code-skill sessions -n 20              # List recent sessions
claude-code-skill session-search "bug fix"    # Search by query
claude-code-skill session-search --project ~/myapp  # Filter by project
claude-code-skill session-search --since "2h" # Filter by time
claude-code-skill resume <session-id> "Continue" -d ~/project  # Resume
```

## Batch Operations

```bash
# Read multiple files
claude-code-skill batch-read "src/**/*.ts" "tests/**/*.test.ts" -p ~/project
```

## Examples

### Code Review

```bash
claude-code-skill session-start review -d ~/project --permission-mode plan
claude-code-skill session-send review "Review all TypeScript files for security issues" --stream
```

### Automated Testing

```bash
claude-code-skill session-start test -d ~/project \
  --allowed-tools "Bash(npm:*),Read,Write" \
  --max-budget 1.00

claude-code-skill session-send test "Find untested functions and write tests"
```

### Multi-Agent Debugging

```bash
claude-code-skill session-start debug -d ~/project \
  --agents '{
    "detective": {"prompt": "Find root cause"},
    "fixer": {"prompt": "Implement fixes"},
    "tester": {"prompt": "Verify fixes"}
  }' \
  --agent detective

claude-code-skill session-send debug "Memory leak in API server" --stream
```

## Best Practices

1. **Use persistent sessions** for multi-step tasks
2. **Enable streaming** (`--stream`) for long operations
3. **Set budget limits** (`--max-budget`) for safety
4. **Use plan mode** (`--permission-mode plan`) for critical changes
5. **Fork before experiments** to preserve the original session

## License

MIT
