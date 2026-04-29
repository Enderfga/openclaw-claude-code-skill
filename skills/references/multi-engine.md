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
├── engine: 'cursor'  → PersistentCursorSession
│   └── Wraps: agent -p --force --output-format stream-json (per-message spawning)
└── engine: 'custom'  → PersistentCustomSession
    └── Wraps: any CLI via user-provided CustomEngineConfig
```

## Supported Engines

### Claude Code (`engine: 'claude'`)

Default engine. Long-running subprocess with streaming JSON I/O. Tested with Claude Code CLI **2.1.121**.

- Persistent multi-turn conversations
- Real-time streaming (text, tool_use, tool_result, system events)
- Session resume via `--resume`
- Full cost tracking from API usage data
- Hook lifecycle events (`includeHookEvents`), permission delegation (`permissionPromptTool`), prompt cache optimization (`bare` + `excludeDynamicSystemPromptSections` + `enablePromptCaching1H`), debug control, `--from-pr` resume, and MCP channel subscriptions
- Fork subagent (`forkSubagent`), tool search (`enableToolSearch`), OpenTelemetry logging toggles (`otelLogUserPrompts`, `otelLogRawApiBodies`), `xhigh` effort tier (Opus 4.7), and `stats.pluginErrors` capture — see [CLI 2.1.121 options in SKILL.md](../SKILL.md) and [tools.md](./tools.md)

> **Behavior changes from upstream Claude CLI 2.1.121** (worth knowing if you set permission rules):
> - `--agent` / `--print` now enforce agent frontmatter `permissionMode`, `tools`, `disallowedTools` (was advisory). Affects `council` agent personas.
> - `Bash(find:*)` permission rule no longer auto-approves `find -exec` or `find -delete`. Add explicit rules if you depend on these.
> - `--dangerously-skip-permissions` also skips prompts for `.claude/skills/` directory. Treat with care.
> - Distributed tracing context (`TRACEPARENT` / `TRACESTATE`) is automatically forwarded to the child process — set them in the parent before starting the session.

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
  model: 'gpt-5.4',
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
  model: 'gemini-3.1-pro-preview',
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

Team tools (`team_list`, `team_send`) operate on the same virtual-team layer for **every** engine: the "team" is the set of all active sessions managed by SessionManager.

| Engine | `team_list` | `team_send` |
|--------|------------|-------------|
| Claude | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Codex | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Gemini | Lists other active SessionManager sessions | Routes via cross-session inbox |
| Cursor | Lists other active SessionManager sessions | Routes via cross-session inbox |

Messages are delivered via the inbox system — idle sessions receive immediately, busy sessions queue for later delivery.

> **Note:** Claude Code does have a native experimental "Agent Teams" feature (v2.1.32+, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), but it is an in-process TUI mechanism with no slash command or stdin-driven messaging — a subprocess wrapper cannot access its mailbox. Plugin team tools therefore use the engine-agnostic virtual team across the board.

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

## Custom Engine (`engine: 'custom'`)

Integrate **any** coding agent CLI without writing engine-specific code. You provide a `CustomEngineConfig` that maps your CLI's flags to OpenClaw session concepts.

Two protocol modes:
- **Persistent** (`persistent: true`) — long-running subprocess with stream-json I/O over stdin/stdout (like Claude Code)
- **One-shot** (`persistent: false`, default) — new process spawned per `send()` (like Gemini/Codex)

### CustomEngineConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name (used in logs, session IDs) |
| `bin` | string | yes | Binary path or command name |
| `binEnv` | string | | Env var name that overrides `bin` at runtime |
| `persistent` | boolean | | `true` = persistent subprocess, `false` = one-shot (default) |
| `args` | object | yes | CLI flag mappings (see below) |
| `permissionModes` | object | | Maps OpenClaw mode names to CLI-specific values |
| `pricing` | object | | `{ input, output, cached? }` per 1M tokens |
| `contextWindow` | number | | Context window size (default: 200,000) |
| `env` | object | | Extra environment variables for the CLI process |
| `sanitizePatterns` | string[] | | Regex patterns to redact from stderr |

### args field

| Key | Example | Description |
|-----|---------|-------------|
| `print` | `"-p"` | Non-interactive/print mode flag |
| `outputFormat` | `"--output-format"` | Output format flag |
| `outputFormatValue` | `"stream-json"` | Value for stream-json output |
| `inputFormat` | `"--input-format"` | Input format flag (persistent only) |
| `inputFormatValue` | `"stream-json"` | Value for stream-json input |
| `skipPermissions` | `"-y"` | Skip all permissions flag |
| `permissionMode` | `"--permission-mode"` | Permission mode flag |
| `model` | `"--model"` | Model selection flag |
| `systemPrompt` | `"--system-prompt"` | System prompt override flag |
| `appendSystemPrompt` | `"--append-system-prompt"` | Append system prompt flag |
| `maxTurns` | `"--max-turns"` | Max agent turns flag |
| `resume` | `"--resume"` | Session resume flag (persistent only) |
| `verbose` | `"--verbose"` | Verbose output flag |
| `replayUserMessages` | `"--replay-user-messages"` | Replay user messages (persistent only) |
| `includePartialMessages` | `"--include-partial-messages"` | Include partial messages (persistent only) |
| `effort` | `"--effort"` | Effort level flag |
| `workspace` | `"--workspace"` | Workspace/cwd flag (one-shot only) |
| `extra` | `["--trust"]` | Additional static arguments |

### Example: Persistent mode (Claude Code-compatible CLI)

```typescript
await manager.startSession({
  name: 'my-agent-task',
  engine: 'custom',
  cwd: '/project',
  customEngine: {
    name: 'my-agent',
    bin: 'my-agent',
    binEnv: 'MY_AGENT_BIN',
    persistent: true,
    args: {
      print: '-p',
      outputFormat: '--output-format',
      outputFormatValue: 'stream-json',
      inputFormat: '--input-format',
      inputFormatValue: 'stream-json',
      skipPermissions: '-y',
      permissionMode: '--permission-mode',
      model: '--model',
      systemPrompt: '--system-prompt',
      appendSystemPrompt: '--append-system-prompt',
      maxTurns: '--max-turns',
      resume: '--resume',
      verbose: '--verbose',
      replayUserMessages: '--replay-user-messages',
      includePartialMessages: '--include-partial-messages',
    },
    pricing: { input: 3, output: 15, cached: 0.3 },
    contextWindow: 200_000,
    sanitizePatterns: ['MY_API_KEY=[^\\s]+'],
  },
});
```

### Example: One-shot mode (simple CLI)

```typescript
await manager.startSession({
  name: 'simple-agent-task',
  engine: 'custom',
  cwd: '/project',
  customEngine: {
    name: 'simple-agent',
    bin: '/usr/local/bin/simple-agent',
    persistent: false,  // default
    args: {
      print: '-p',
      outputFormat: '--output-format',
      outputFormatValue: 'stream-json',
      skipPermissions: '--yolo',
      model: '--model',
      workspace: '--workspace',
      extra: ['--no-color'],
    },
    permissionModes: {
      bypassPermissions: 'yolo',
      default: 'sandbox',
    },
    pricing: { input: 1, output: 5 },
  },
});
```

### Custom Engine in Council

Custom engines work in council by setting `engine: 'custom'` and `customEngine` on the agent persona:

```typescript
manager.councilStart('Build feature X', {
  agents: [
    {
      name: 'Planner',
      emoji: '🟠',
      persona: 'Architecture expert',
      engine: 'custom',
      customEngine: { name: 'my-agent', bin: 'my-agent', persistent: true, args: { ... } },
    },
    { name: 'Reviewer', emoji: '🔵', persona: 'Code reviewer', engine: 'claude', model: 'opus' },
  ],
  maxRounds: 10,
  projectDir: '/project',
});
```

## Adding a New Built-in Engine

To add a built-in engine (for CLIs that need custom protocol handling beyond what `CustomEngineConfig` supports):

1. Create `src/persistent-<engine>-session.ts` implementing `ISession`
2. Add the engine name to `EngineType` in `src/types.ts`
3. Add a case to `SessionManager._createSession()`
4. Add model pricing to `MODELS[]` in `src/models.ts`

The `ISession` interface is deliberately minimal — each engine handles its own subprocess bootstrapping, I/O protocol, and cleanup internally.

For most third-party CLIs, the `custom` engine with `CustomEngineConfig` is sufficient and requires zero code changes.
