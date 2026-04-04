# Multi-Engine

openclaw-claude-code supports multiple coding CLI engines behind a unified `ISession` interface. Each engine manages its own subprocess, event stream, and cost tracking independently.

## Architecture

```
SessionManager
├── engine: 'claude'  → PersistentClaudeSession
│   └── Wraps: claude CLI (stream-json protocol, persistent subprocess)
├── engine: 'codex'   → PersistentCodexSession
│   └── Wraps: codex exec --full-auto (per-message spawning)
├── engine: 'gemini'  → PersistentGeminiSession
│   └── Wraps: gemini -p --output-format stream-json (per-message spawning)
└── engine: 'cursor'  → PersistentCursorSession
    └── Wraps: agent -p --force --output-format stream-json (per-message spawning)
```

## Supported Engines

### Claude Code (`engine: 'claude'`)

Default engine. Long-running subprocess with streaming JSON I/O.

- Persistent multi-turn conversations
- Real-time streaming (text, tool_use, tool_result events)
- Session resume via `--resume`
- Full cost tracking from API usage data

```typescript
await manager.startSession({
  name: 'claude-task',
  engine: 'claude',       // default, can omit
  model: 'opus',
  cwd: '/project',
});
```

### OpenAI Codex (`engine: 'codex'`)

Wraps the `codex exec` subcommand in full-auto mode. Each `send()` spawns a new process.

- Non-interactive execution via `codex exec --full-auto`
- Working directory passed via `-C` flag
- One-shot execution per message (no persistent subprocess)
- Working directory carries accumulated changes across sends
- Token estimation from response length (~4 chars/token)
- Requires `codex` CLI >= 0.112: `npm install -g @openai/codex`

```typescript
await manager.startSession({
  name: 'codex-task',
  engine: 'codex',
  model: 'o4-mini',
  cwd: '/project',
});
```

### Google Gemini (`engine: 'gemini'`)

Wraps the `gemini` CLI with `--output-format stream-json`. Each `send()` spawns a new process.

- One-shot execution per message (no persistent subprocess)
- Working directory carries accumulated changes across sends
- Real token counts from stream-json `result` events (not estimated)
- Permission modes: `bypassPermissions` → `--yolo`, `default` → `--sandbox`
- Requires `gemini` CLI installed: `npm install -g @google/gemini-cli`

```typescript
await manager.startSession({
  name: 'gemini-task',
  engine: 'gemini',
  model: 'gemini-pro',   // alias for gemini-2.5-pro
  cwd: '/project',
});
```

### Cursor Agent (`engine: 'cursor'`)

Wraps the Cursor Agent CLI (`agent`) with `--print --force --output-format stream-json`. Each `send()` spawns a new process.

- One-shot execution per message (no persistent subprocess)
- Working directory via `--workspace` flag
- Real token counts from stream-json `result` events (camelCase: `inputTokens`, `outputTokens`, `cacheReadTokens`)
- `--force` enables auto-approval of all file changes
- `--trust` auto-trusts the workspace without prompting
- Cursor uses its own model routing (e.g., `sonnet-4`, `gpt-5`, `auto`)
- Requires Cursor Agent CLI: `curl https://cursor.com/install -fsSL | bash`
- Binary: `agent` (set `CURSOR_BIN` env var to override)

```typescript
await manager.startSession({
  name: 'cursor-task',
  engine: 'cursor',
  model: 'sonnet-4',
  cwd: '/project',
});
```

## ISession Interface

All engines implement `ISession`, making them interchangeable at the `SessionManager` level:

```typescript
interface ISession {
  // State
  sessionId?: string;
  readonly isReady: boolean;
  readonly isPaused: boolean;
  readonly isBusy: boolean;

  // Lifecycle
  start(): Promise<this>;
  stop(): void;
  pause(): void;
  resume(): void;

  // Communication
  send(message, options?): Promise<TurnResult | { requestId; sent }>;

  // Observability
  getStats(): SessionStats & { sessionId?; uptime };
  getHistory(limit?): Array<{ time; type; event }>;
  getCost(): CostBreakdown;

  // Context
  compact(summary?): Promise<TurnResult | { requestId; sent }>;
  getEffort(): EffortLevel;
  setEffort(level): void;

  // Model
  resolveModel(alias): string;

  // Events (EventEmitter)
  on(event, listener): this;
  emit(event, ...args): boolean;
}
```

## Team Tools Across Engines

Team tools (`team_list`, `team_send`) work on all engines with engine-appropriate implementations:

| Engine | `team_list` | `team_send` |
|--------|------------|-------------|
| Claude | Native `/team` command | Native `@teammate` command |
| Codex | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Gemini | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Cursor | Lists other active SessionManager sessions | Routes via cross-session inbox |

For Codex, Gemini, and Cursor, the "team" is the set of all active sessions managed by SessionManager. Messages are delivered via the inbox system — idle sessions receive immediately, busy sessions queue for later delivery.

## Proxy: Any Model via OpenClaw Gateway

Claude Code CLI only speaks Anthropic protocol. The built-in proxy translates Anthropic ↔ OpenAI format, letting you drive Claude Code with **any model** routed through the OpenClaw gateway.

### Zero Config

If OpenClaw gateway is running, everything is automatic:

```typescript
// No baseUrl, no env vars, no extra config
await manager.startSession({
  name: 'task',
  engine: 'claude',
  model: 'openclaw',        // gateway routes to your configured model
  cwd: '/project',
});
```

What happens behind the scenes:
1. Plugin reads `~/.openclaw/openclaw.json` for gateway port + auth
2. Starts a local proxy server (random port, auto-managed)
3. Claude Code CLI sends Anthropic-format requests → proxy converts to OpenAI → gateway → any model

### Manual Config (optional)

Override with environment variables if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_URL` | Auto-detected from openclaw.json | Gateway endpoint (e.g. `http://127.0.0.1:18789/v1`) |
| `GATEWAY_KEY` | Auto-detected from openclaw.json | Gateway auth password/token |
| `GEMINI_API_KEY` | - | Direct Gemini API access (bypasses gateway) |
| `OPENAI_API_KEY` | - | Direct OpenAI API access (bypasses gateway) |

### Architecture

```
Claude Code CLI (Anthropic format)
  → Auto-proxy (Anthropic → OpenAI conversion)
    → OpenClaw Gateway (/v1/chat/completions, model="openclaw")
      → Any model (Gemini, GPT, local, etc.)
```

## Adding a New Engine

To add support for a new CLI (e.g., Aider, Cursor CLI):

1. Create `src/persistent-<engine>-session.ts` implementing `ISession`
2. Add the engine name to `EngineType` in `src/types.ts`
3. Add a case to `SessionManager._createSession()`
4. Add model pricing to `MODEL_PRICING` if applicable

The `ISession` interface is deliberately minimal — each engine handles its own subprocess bootstrapping, I/O protocol, and cleanup internally.
