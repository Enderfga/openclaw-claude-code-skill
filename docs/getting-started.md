# Getting Started

## Installation

### As OpenClaw Plugin

```bash
openclaw plugins install @enderfga/openclaw-claude-code --dangerously-force-unsafe-install
openclaw gateway restart
```

> **Why `--dangerously-force-unsafe-install`?** This plugin spawns Claude Code / Codex CLI subprocesses via `child_process`, which OpenClaw's security scanner flags by design. The flag is required — there is no way to drive coding CLIs without process spawning.

Agents automatically get access to all session, council, and management tools.

### Standalone CLI

```bash
npm install -g @enderfga/openclaw-claude-code

# Start the embedded server
claude-code-skill serve

# Drive sessions from the command line
claude-code-skill session-start myproject -d ~/project
claude-code-skill session-send myproject "fix the auth bug"
claude-code-skill session-stop myproject
```

### TypeScript Library

```typescript
import { SessionManager } from '@enderfga/openclaw-claude-code';

const manager = new SessionManager({ defaultModel: 'claude-sonnet-4-6' });

const session = await manager.startSession({
  name: 'backend-fix',
  cwd: '/path/to/project',
  permissionMode: 'acceptEdits',
});

const result = await manager.sendMessage('backend-fix', 'Fix the failing tests');
console.log(result.output);

await manager.stopSession('backend-fix');
```

## Requirements

- **Node.js >= 22**
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **OpenClaw >= 2026.3.0** — for plugin mode (optional)
- **OpenAI Codex CLI** — `npm install -g @openai/codex` (optional, for codex engine)
- **Gemini CLI** — `npm install -g @google/gemini-cli` (optional, for gemini engine)

## Configuration

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
          "sessionTtlMinutes": 120,
          "proxy": {
            "enabled": false,
            "bigModel": "gemini-2.5-pro",
            "smallModel": "gemini-2.5-flash"
          }
        }
      }
    }
  }
}
```

## Next Steps

- [Sessions](./sessions.md) — persistent session lifecycle and management
- [Session Inbox](./inbox.md) — cross-session messaging
- [Multi-Engine](./multi-engine.md) — using Claude Code and Codex side by side
- [Council](./council.md) — multi-agent collaboration with consensus voting
- [Ultraplan & Ultrareview](./ultra.md) — deep planning and fleet code review
- [Tools Reference](./tools.md) — complete tool API reference (27 tools)
- [CLI Reference](./cli.md) — command-line interface
