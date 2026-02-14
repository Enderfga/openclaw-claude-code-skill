---
name: claude-code-skill
description: Control Claude Code via MCP protocol. Execute commands, read/write files, search code, and use all Claude Code tools programmatically with agent team support.
homepage: https://github.com/enderfga/claude-code-skill
metadata: {
  "clawdis": {
    "emoji": "🤖",
    "requires": {
      "bins": ["node"],
      "env": []
    },
    "install": [
      {
        "id": "local",
        "kind": "local",
        "path": "~/clawd/claude-code-skill",
        "label": "Use local installation"
      }
    ]
  }
}
---

# Claude Code Skill

Control Claude Code via MCP (Model Context Protocol). This skill unleashes the full power of Claude Code for openclaw agents, including persistent sessions, agent teams, and advanced tool control.

## ⚡ Quick Start

```bash
# Start a persistent Claude session for your project
claude-code-skill session-start myproject -d ~/project \
  --permission-mode plan \
  --allowed-tools "Bash,Read,Edit,Write,Glob,Grep" \
  --max-budget 2.00

# Send a complex task (Claude will autonomously use tools)
claude-code-skill session-send myproject "Find all TODO comments and create GitHub issues" --stream

# Check progress
claude-code-skill session-status myproject
```

## 🎯 When to Use This Skill

### Use Persistent Sessions When:
- ✅ Multi-step tasks requiring multiple tool calls
- ✅ Iterative development (write code → test → fix → repeat)
- ✅ Long conversations needing full context
- ✅ Agent needs to work autonomously
- ✅ You want streaming real-time feedback

### Use Direct MCP Tools When:
- ✅ Single command execution
- ✅ Quick file read/write
- ✅ One-off searches
- ✅ No context needed between operations

## 📚 Command Reference

### Basic MCP Operations

```bash
# Connect to Claude Code MCP
claude-code-skill connect
claude-code-skill status
claude-code-skill tools

# Direct tool calls (no persistent session)
claude-code-skill bash "npm test"
claude-code-skill read /path/to/file.ts
claude-code-skill glob "**/*.ts" -p ~/project
claude-code-skill grep "TODO" -p ~/project -c
claude-code-skill call Write -a '{"file_path":"/tmp/test.txt","content":"Hello"}'

# Disconnect
claude-code-skill disconnect
```

### Persistent Sessions (Agent Loop)

#### Starting Sessions

```bash
# Basic start
claude-code-skill session-start myproject -d ~/project

# With custom API endpoint (for Gemini/GPT proxy)
claude-code-skill session-start gemini-task -d ~/project \
  --base-url http://127.0.0.1:8082 \
  --model gemini-2.0-flash

# With permission mode (plan = preview changes before applying)
claude-code-skill session-start review -d ~/project --permission-mode plan

# With tool whitelist (auto-approve these tools)
claude-code-skill session-start safe -d ~/project \
  --allowed-tools "Bash(git:*),Read,Glob,Grep"

# With budget limit
claude-code-skill session-start limited -d ~/project --max-budget 1.50

# Full configuration
claude-code-skill session-start advanced -d ~/project \
  --permission-mode acceptEdits \
  --allowed-tools "Bash,Read,Edit,Write" \
  --disallowed-tools "Task" \
  --max-budget 5.00 \
  --model claude-opus-4-5 \
  --append-system-prompt "Always write tests" \
  --add-dir "/tmp,/var/log"
```

**Permission Modes:**
| Mode | Description |
|------|-------------|
| `acceptEdits` | Auto-accept file edits (default) |
| `plan` | Preview changes before applying |
| `default` | Ask for each operation |
| `bypassPermissions` | Skip all prompts (dangerous!) |
| `delegate` | Delegate decisions to parent |
| `dontAsk` | Never ask, reject by default |

#### Sending Messages

```bash
# Basic send (blocks until complete)
claude-code-skill session-send myproject "Write unit tests for auth.ts"

# Streaming (see progress in real-time)
claude-code-skill session-send myproject "Refactor this module" --stream

# With custom timeout
claude-code-skill session-send myproject "Run all tests" -t 300000
```

#### Managing Sessions

```bash
# List active sessions
claude-code-skill session-list

# Get detailed status
claude-code-skill session-status myproject

# View conversation history
claude-code-skill session-history myproject -n 50

# Pause and resume
claude-code-skill session-pause myproject
claude-code-skill session-resume-paused myproject

# Fork a session (create a branch for experiments)
claude-code-skill session-fork myproject myproject-experiment

# Stop
claude-code-skill session-stop myproject

# Restart a failed session
claude-code-skill session-restart myproject
```

### Session History & Search

```bash
# Browse all Claude Code sessions
claude-code-skill sessions -n 20

# Search sessions by project
claude-code-skill session-search --project ~/myapp

# Search by time
claude-code-skill session-search --since "2h"
claude-code-skill session-search --since "2024-02-01"

# Search by query
claude-code-skill session-search "bug fix"

# Resume a historical session
claude-code-skill resume <session-id> "Continue where we left off" -d ~/project
```

### Batch Operations

```bash
# Read multiple files at once
claude-code-skill batch-read "src/**/*.ts" "tests/**/*.test.ts" -p ~/project
```

## 🤝 Agent Team Features

Deploy multiple Claude agents working together on complex tasks.

### Basic Agent Team

```bash
# Define a team of agents
claude-code-skill session-start team-project -d ~/project \
  --agents '{
    "architect": {
      "description": "Designs system architecture",
      "prompt": "You are a senior software architect. Design scalable, maintainable systems."
    },
    "developer": {
      "description": "Implements features",
      "prompt": "You are a full-stack developer. Write clean, tested code."
    },
    "reviewer": {
      "description": "Reviews code quality",
      "prompt": "You are a code reviewer. Check for bugs, style issues, and improvements."
    }
  }' \
  --agent architect

# Switch between agents mid-conversation
claude-code-skill session-send team-project "Design the authentication system"
# (architect responds)

claude-code-skill session-send team-project "@developer implement the design"
# (developer agent takes over)

claude-code-skill session-send team-project "@reviewer review the implementation"
# (reviewer agent takes over)
```

### Pre-configured Team Templates

```bash
# Code review team
claude-code-skill session-start review -d ~/project \
  --agents '{
    "security": {"prompt": "Focus on security vulnerabilities"},
    "performance": {"prompt": "Focus on performance issues"},
    "quality": {"prompt": "Focus on code quality and maintainability"}
  }' \
  --agent security

# Full-stack team
claude-code-skill session-start fullstack -d ~/project \
  --agents '{
    "frontend": {"prompt": "React/TypeScript frontend specialist"},
    "backend": {"prompt": "Node.js/Express backend specialist"},
    "database": {"prompt": "PostgreSQL/Redis database specialist"}
  }' \
  --agent frontend
```

## 🔧 Advanced Features

### Tool Control

```bash
# Allow specific tools with patterns
--allowed-tools "Bash(git:*,npm:*),Read,Edit"

# Deny dangerous operations
--disallowed-tools "Bash(rm:*,sudo:*),Write(/etc/*)"

# Limit to specific tool set
--tools "Read,Glob,Grep"

# Disable all tools
--tools ""
```

### System Prompts

```bash
# Replace system prompt completely
--system-prompt "You are a Python expert. Always use type hints."

# Append to existing prompt
--append-system-prompt "Always run tests after changes."
```

### Session Management

```bash
# Resume with fork (create a branch)
--resume <session-id> --fork-session

# Use custom UUID for session
--session-id "550e8400-e29b-41d4-a716-446655440000"

# Add additional working directories
--add-dir "/var/log,/tmp/workspace"
```

### Multi-Model Support (Proxy)

Use `--base-url` to route requests through a proxy, enabling other models (Gemini, GPT) to power Claude Code:

```bash
# Use Gemini via claude-code-proxy
claude-code-skill session-start gemini-task -d ~/project \
  --base-url http://127.0.0.1:8082 \
  --model claude-3-5-sonnet-20241022  # Proxy will map to Gemini

# Use GPT via proxy
claude-code-skill session-start gpt-task -d ~/project \
  --base-url http://127.0.0.1:8082 \
  --model claude-3-haiku-20240307  # Proxy will map to GPT
```

**Note:** Requires `claude-code-proxy` running on port 8082 with proper API keys configured.

```bash
# Start the proxy
cd ~/clawd/claude-code-proxy && source .venv/bin/activate
uvicorn server:app --host 127.0.0.1 --port 8082
```

## 🎓 Best Practices

### For OpenClaw Agents

1. **Always use persistent sessions for multi-step tasks**
   ```bash
   # ❌ Bad: Multiple disconnect/reconnect cycles
   claude-code-skill bash "step1"
   claude-code-skill bash "step2"

   # ✅ Good: Single persistent session
   claude-code-skill session-start task -d ~/project
   claude-code-skill session-send task "Do step1 then step2"
   ```

2. **Use `--stream` for long-running tasks**
   ```bash
   claude-code-skill session-send task "Run full test suite" --stream
   ```

3. **Set budget limits for safety**
   ```bash
   --max-budget 2.00  # Stop after $2 of API usage
   ```

4. **Use plan mode for critical changes**
   ```bash
   --permission-mode plan  # Preview before applying
   ```

5. **Fork before experiments**
   ```bash
   claude-code-skill session-fork main experimental
   claude-code-skill session-send experimental "Try risky refactor"
   ```

### Error Recovery

```bash
# If session fails:
claude-code-skill session-status myproject  # Check what happened
claude-code-skill session-history myproject -n 20  # See recent events
claude-code-skill session-restart myproject  # Restart from last good state

# If you need to start over:
claude-code-skill session-stop myproject
claude-code-skill session-start myproject -d ~/project --resume <old-session-id>
```

## 🏗️ Architecture

```
openclaw agent
    ↓
claude-code-skill CLI (this tool)
    ↓ HTTP
backend-api API (:18795)
    ↓ MCP
claude mcp serve (Claude Code)
    ↓
Your files & tools
```

## 🔌 Available Tools (via MCP)

All Claude Code tools are accessible:

| Tool | Description |
|------|-------------|
| Bash | Execute shell commands |
| Read | Read file contents |
| Write | Create/overwrite files |
| Edit | Edit files with string replacement |
| Glob | Find files by pattern |
| Grep | Search file contents |
| Task | Launch sub-agents |
| WebFetch | Fetch web content |
| WebSearch | Search the web |
| Git* | Git operations |
| AskUserQuestion | Interactive prompts |
| ... | and 10+ more |

## 📊 Examples

### Example 1: Code Review

```bash
claude-code-skill session-start review -d ~/myapp \
  --permission-mode plan \
  --agents '{"security":{"prompt":"Focus on security"},"quality":{"prompt":"Focus on quality"}}' \
  --agent security

claude-code-skill session-send review \
  "Review all TypeScript files in src/, check for security issues and code quality problems" \
  --stream
```

### Example 2: Automated Testing

```bash
claude-code-skill session-start test -d ~/myapp \
  --allowed-tools "Bash(npm:*,git:*),Read,Write" \
  --max-budget 1.00

claude-code-skill session-send test \
  "Find all untested functions, write unit tests, run tests, fix failures"
```

### Example 3: Multi-Agent Debugging

```bash
claude-code-skill session-start debug -d ~/myapp \
  --agents '{
    "detective": {"prompt": "Find the root cause of bugs"},
    "fixer": {"prompt": "Implement fixes"},
    "tester": {"prompt": "Verify fixes work"}
  }' \
  --agent detective

claude-code-skill session-send debug "We have a memory leak in the API server" --stream
# Detective investigates, then hands off to fixer, then to tester
```

## 🔗 Integration with OpenClaw

When openclaw needs to perform complex coding tasks:

```bash
# From within openclaw agent context:
openclaw skills run claude-code-skill -- session-start task -d ~/project
openclaw skills run claude-code-skill -- session-send task "Implement feature X" --stream
openclaw skills run claude-code-skill -- session-status task
```

Or use the skill programmatically via backend-api HTTP API (see TOOLS.md section 3).

## 📖 See Also

- **TOOLS.md section 3** - Full HTTP API documentation
- **backend-api endpoints** - Backend integration details
- **Claude Code docs** - Official Claude Code documentation (query via `qmd` tool)
