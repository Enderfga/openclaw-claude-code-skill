# Multi-Engine

openclaw-claude-code supports multiple coding CLI engines behind a unified `ISession` interface. Each engine manages its own subprocess, event stream, and cost tracking independently.

## Architecture

```
SessionManager
├── engine: 'claude' → PersistentClaudeSession
│   └── Wraps: claude CLI (stream-json protocol, persistent subprocess)
├── engine: 'codex'  → PersistentCodexSession
│   └── Wraps: codex CLI (--full-auto --quiet, per-message spawning)
└── engine: 'gemini' → PersistentGeminiSession
    └── Wraps: gemini CLI (--output-format stream-json, per-message spawning)
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

Wraps the `codex` CLI in quiet + full-auto mode. Each `send()` spawns a new process.

- One-shot execution per message (no persistent subprocess)
- Working directory carries accumulated changes across sends
- Token estimation from response length (~4 chars/token)
- Requires `codex` CLI installed: `npm install -g @openai/codex`

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

## Adding a New Engine

To add support for a new CLI (e.g., Aider, Cursor CLI):

1. Create `src/persistent-<engine>-session.ts` implementing `ISession`
2. Add the engine name to `EngineType` in `src/types.ts`
3. Add a case to `SessionManager._createSession()`
4. Add model pricing to `MODEL_PRICING` if applicable

The `ISession` interface is deliberately minimal — each engine handles its own subprocess bootstrapping, I/O protocol, and cleanup internally.
