# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] - 2026-04-10

### Added
- **Custom Engine (`engine: 'custom'`)** — integrate any coding agent CLI without writing engine-specific code. Users provide a `CustomEngineConfig` that maps CLI flags to OpenClaw session concepts. Supports two modes:
  - **Persistent** (`persistent: true`) — long-running subprocess with stream-json I/O over stdin/stdout (for Claude Code-compatible CLIs)
  - **One-shot** (`persistent: false`, default) — new process per `send()` (for simpler CLIs)
- Full config surface: binary path, flag mappings, permission mode translation, pricing, context window, env vars, stderr sanitization patterns
- Custom engines work in **council** — set `engine: 'custom'` + `customEngine` on agent personas
- New source file: `src/persistent-custom-session.ts` implementing `ISession`
- New type: `CustomEngineConfig` in `src/types.ts`
- New export: `PersistentCustomSession` from package entry point

## [2.9.4] - 2026-04-09

### Fixed
- **openai-compat: system prompt not injected for non-Claude engines** — Cursor, Codex, and Gemini CLIs don't support `--append-system-prompt`, so the upstream caller's system prompt (OpenClaw agent identity, tool definitions, workspace context) was silently dropped. Now prepended as `<system>...</system>` to the user message on every turn for non-Claude engines.
- **openai-compat: removed forceNonStream** — returning JSON when the gateway sent `stream: true` caused a protocol mismatch; the OpenAI SDK expected SSE, so webchat received no reply. Streaming with the fixed heartbeat comment format handles cold-start delay correctly.

### Added
- **Cursor Auto model routing** — `model: "auto"` now resolves to the `cursor` engine, enabling Cursor's unlimited Auto mode as a primary backend via the OpenAI-compat bridge.
- **openai-compat: optional status webhook (`OPENAI_COMPAT_STATUS_URL`)** — best-effort `POST` JSON `{ state, activity, tool }` at request start, on each CLI `tool_use` event (human-readable `activity`), when the turn completes (`state: idle`), and on handler failure (so UIs don't stick on `thinking`). Enables a webchat status bar or other dashboard to show live agent activity without parsing SSE.

## [2.9.3] - 2026-04-09

### Fixed
- **openai-compat: persistent CLI destroyed every turn (#40)** — `extractUserMessage()`'s `nonSystemMessages.length <= 1` heuristic fired on every request for clients that forward only the latest user turn (OpenClaw main agent, cron jobs, subagents), causing `stopSession` + `startSession` on every turn, destroying the persistent CLI, and preventing Anthropic prompt caching from ever warming. The heuristic is now off by default; clients that want the old behavior set `OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`. All clients can still force a reset via `X-Session-Reset: 1` (now also accepted case-insensitively with whitespace).
- **openai-compat: unkeyed callers collapsed onto one shared session (#40)** — `resolveSessionKey()` returned the literal string `'default'` when neither `X-Session-Id` nor `user` was set, so multi-caller setups all shared one `openai-default` plugin session and could see each other's `appendSystemPrompt` (a privacy leak across distinct callers). Now falls back to `'sys-<sha1(model + systemPrompt)>'` so distinct callers land on distinct sessions.
- **openai-compat: session key ignored requested model (#40)** — two callers with the same system prompt but different requested models collided onto one session and silently got responses from whichever model the session was created with. Model is now mixed into the hash input.
- **session-manager: concurrent `sendMessage()` race on the same session** — `PersistentClaudeSession`'s single-slot `_streamCallbacks` and shared `TURN_COMPLETE` listener could race when two callers sent on the same session simultaneously, causing the second caller to receive the first caller's response. `SessionManager.sendMessage()` now serializes per-session via a chained promise, with failure isolation so a thrown send doesn't poison the chain.
- **openai-compat: SSE heartbeat killed streaming for OpenAI SDK clients** — `writeSSE(':keepalive')` produced `data: :keepalive\n\n` which the OpenAI SDK's `SSEDecoder` tried to `JSON.parse`, throwing `SyntaxError` and aborting the stream. Replaced with a proper SSE comment (`': keepalive\n\n'`), interval increased from 15s to 30s. This was the root cause of `outputs: []` when the OpenClaw gateway's agent loop (43KB system prompt, >15s first-token latency) streamed through the bridge.
- **openai-compat: new sessions forced non-streaming on first turn** — Claude CLI needs 3-15s to boot and process the system prompt. Upstream clients (OpenClaw gateway, OpenAI SDK) would close the streaming connection before the first content chunk arrived. The bridge now forces non-streaming mode for the first turn of a new session, then allows streaming on subsequent turns where the CLI is already warm (<1s first-token).
- **openai-compat: poisoned session auto-resume from disk** — sessions that crashed during creation (e.g. `claude` not in PATH) were persisted to `claude-sessions.json`. On every server restart, `SessionManager._doStartSession` auto-resumed the broken `claudeSessionId`, producing zero-output sessions that could never recover. OpenAI-compat sessions now set `skipPersistence: true` + `noSessionPersistence: true` so they never persist to disk and never auto-resume stale CLI state.
- **openai-compat: `content` field as array not handled** — the OpenAI API allows `content` as `string | Array<{type, text}>` (multimodal messages). `extractUserMessage` now normalizes array content via a `textOf()` helper instead of assuming string.
- **openai-compat: `OpenAIChatMessage` type too narrow** — added `role: 'tool'`, `content: null | Array`, `tool_calls`, `tool_call_id` fields. `OpenAIChatCompletionRequest` now includes `tools`, `max_completion_tokens`. These fields are accepted but intentionally not forwarded to the Claude CLI — the bridge delegates all tool use to Claude Code's own tool system.

### Added
- **`OPENAI_COMPAT_NEW_CONVO_HEURISTIC` env var** — opt-in legacy heuristic for webchat frontends that re-send the full transcript (ChatGPT-Next-Web, Open WebUI, etc).
- **`GET /v1/sessions` inspection endpoint** — lists active OpenAI-compat sessions with `cached_tokens`, `tokens_in/out`, `turns`, `context_percent`, `cost_usd`. Production observability for verifying that prompt caching is actually warming. Bearer-token gated like the rest of `/v1/*`.
- **Serve-mode tuning env vars** — `OPENCLAW_SERVE_MAX_SESSIONS` (default 32, was 5) and `OPENCLAW_SERVE_TTL_MINUTES` (default 60, was 120). Plugin-mode defaults are unchanged.
- **`skills/references/openai-compat.md`** — dedicated reference for the OpenAI-compat bridge: session keying rules, the two operator modes, env vars, smoke-test recipes.
- **Tests** — 11 new unit tests covering: positive `X-Session-Reset` (1/true/case-insensitive/whitespace), negative reset values, distinct hash by system prompt, distinct hash by model, model-only hash, legacy-heuristic env-var restore, per-session send mutex serialization, mutex recovery from a failed send.

### Important
- **Extra usage billing**: When OpenClaw's agent loop routes through this bridge, Anthropic recognizes the system prompt signature as programmatic/agent traffic and bills it against Claude Code's **extra usage** quota at standard API rates. This bridge does NOT bypass Anthropic's subscription enforcement or billing — it is not a workaround for API access restrictions.

### Credits
- Bug diagnosis (#40) by @megayounus786.

## [2.9.2] - 2026-04-05

### Fixed
- **Session creation race condition** — concurrent `startSession()` calls for the same name now check `_pendingSessions` before `sessions.has()`, preventing duplicate session creation
- **Streaming proxy timeout** — `handleStreamingResponse` now uses `fetchWithRetry` (1 retry) instead of bare `fetch`, preventing indefinite hangs on upstream failures
- **Swallowed errors in PersistentClaudeSession** — 7 empty `catch {}` blocks now log errors via `SESSION_EVENT.LOG` instead of silently ignoring them; process kill catches distinguish `ESRCH` (expected) from `EPERM` (logged)
- **Hook errors logged** — `_fireHook` catch block now emits error message instead of swallowing
- **Unsafe type casts** — removed `as unknown as` double casts in `openai-compat.ts` (body validation before cast, `usage` field added to chunk type) and `persistent-session.ts` (StreamEvent index signature makes direct cast valid)
- **`max_tokens` validation** — OpenAI-compat endpoint now rejects non-positive `max_tokens` with 400

## [2.9.1] - 2026-04-05

### Fixed
- **CLI argument parsing** — comma-separated `--allowed-tools`, `--disallowed-tools`, `--add-dir`, `--mcp-config`, and `--betas` flags now trim whitespace and filter empty entries
- **API key sanitization** — stderr redaction now catches `sk-proj-*` and other `sk-*` key formats (previously only matched `sk-ant-*`)
- **Council worktree cleanup** — if a worktree creation fails mid-batch, already-created worktrees are cleaned up instead of left dangling
- **Council history pollution** — empty agent responses are now filtered from collaboration history prompts
- **Council TTL abort** — still-running councils are aborted at TTL expiry instead of silently deleted
- **Ultraplan TTL** — still-running ultraplans are marked as error at TTL expiry

### Added
- **`estimateTokens()`** — shared token estimation utility (`~4 chars/token`), replaces 3 inline duplicates across Codex/Gemini/Cursor sessions
- **`lookupModelStrict()`** — throws for unknown models instead of returning `undefined`
- **Pricing fallback warning** — `getModelPricing()` now logs a `console.warn` when falling back to default pricing for unknown models
- **Tests: `persistent-session.test.ts`** — 31 tests for Claude CLI engine (arg assembly, events, cost, send, stderr sanitization, stop)
- **Tests: `proxy-handler.test.ts`** — 17 tests for proxy handler (routing, retry, streaming, errors)
- **Tests: `embedded-server.test.ts`** — 22 tests for HTTP server (health, auth, rate limiting, body limits, routing, CORS, errors)

### Changed
- **Model detection** — deduplicated inline `CLAUDE_PATTERNS` arrays in `persistent-session.ts` and `session-manager.ts`; both now use centralized `isClaudeModel()` from `models.ts`

## [2.9.0] - 2026-04-05

### Added
- **Centralized model registry** (`src/models.ts`) — single source of truth for all 17 models across 4 providers. Model definitions, pricing, aliases, engine mappings, context windows, and `/v1/models` list are all auto-generated from one `MODELS[]` array. Adding a model is now a one-line change
- **Per-model context window** — `contextPercent` in session stats now uses the actual model's context window (e.g. 1M for Gemini, 256k for GPT-5.4) instead of a fixed 200k assumption
- **Session engine persistence** — `engine` field is now saved/restored across session restarts, so resumed sessions pick up the correct engine without re-specifying it
- **`x-session-reset` header** — OpenAI-compat endpoint now supports an explicit `x-session-reset: true` header to force a new conversation, in addition to the existing message-count heuristic
- **Proxy retry with backoff** — non-streaming proxy requests auto-retry on 429/5xx (up to 2 retries, exponential backoff, respects `Retry-After` header)
- **SSE heartbeat** — streaming responses (both OpenAI-compat and proxy) now send `:keepalive` comments every 15s to prevent proxy/client timeouts
- **Streaming usage** — final SSE chunk in OpenAI-compat streaming now includes `usage` (prompt_tokens, completion_tokens, total_tokens)
- **Configurable rate limit** — `OPENCLAW_RATE_LIMIT` env var overrides the default per-IP rate limit

### Changed
- **`MAX_BODY_SIZE`** increased from 1 MB to 5 MB for larger request payloads
- **`RATE_LIMIT_MAX_REQUESTS`** increased from 100 to 300 per window
- **Error format consistency** — `/v1/*` routes now return OpenAI-standard `{ error: { message, type, code } }` format; internal routes keep `{ ok: false, error }` format
- **Proxy provider detection** — `resolveProvider` now correctly returns `'google'` (not `'gemini'`) as the provider name, matching the `ProviderName` type

### Removed
- **`CONTEXT_WINDOW_SIZE` constant** — replaced by per-model `getContextWindow()` from the model registry
- **Duplicate model definitions** — `MODEL_ENGINE_MAP` (openai-compat.ts), `resolveProviderModel` (handler.ts), `isGeminiModel`/`isClaudeModel` (anthropic-adapter.ts), `DEFAULT_MODEL_PRICING`/`MODEL_PRICING` (types.ts) all consolidated into `src/models.ts`

## [2.8.1] - 2026-04-05

### Changed
- **Model references updated to current flagships** — all code and docs now use current SOTA models: `gpt-5.4`/`gpt-5.4-mini` (OpenAI), `gemini-3.1-pro-preview`/`gemini-3-flash-preview` (Google), `composer-2`/`composer-2-fast` (Cursor). Deprecated model names (`gpt-4o`, `cursor-small`, etc.) removed from docs and `/v1/models` list
- **Updated pricing table** — Opus 4.6 corrected to $5/$25, added GPT-5.4 series, Gemini 3.x, and Composer 2 pricing
- **Council default roles** — renamed default agents from model-based names (GPT/Claude/Gemini) to delivery-stage roles (Planner/Generator/Evaluator) with specialized personas aligned to the Plan → Build → Verify workflow. Engine mappings preserved: Planner→claude, Generator→gpt, Evaluator→gemini

## [2.8.0] - 2026-04-04

### Added
- **OpenAI-compatible `/v1/chat/completions` endpoint** — drop-in backend for webchat apps (ChatGPT-Next-Web, Open WebUI, LobeChat, etc.). Stateful sessions maximize Anthropic prompt caching (90% discount on cached tokens). Supports streaming (SSE) and non-streaming responses
- **`/v1/models` endpoint** — lists supported models for OpenAI client discovery
- **Auto session management** — sessions created/reused per conversation via `X-Session-Id` header or `user` field. Auto-compact when context reaches 80%
- **Multi-engine model routing** — OpenAI `model` field auto-routes to the correct engine (claude/codex/gemini)
- **Configurable CORS** — `/v1/` paths allow cross-origin requests for remote webchat frontends; `OPENCLAW_CORS_ORIGINS=*` for all paths

## [2.7.1] - 2026-04-04

### Added
- **Embedded server authentication** — opt-in bearer token via `OPENCLAW_SERVER_TOKEN` env var; written to `~/.openclaw/server-token` for CLI. `/health` exempt. Default: no auth (localhost binding is the primary boundary)
- **Orphaned process cleanup** — PID file tracking (`~/.openclaw/session-pids.json`) with startup cleanup. Verifies process command line matches known CLIs (claude/codex/gemini/agent) before killing to prevent PID reuse mishaps
- **Circuit breaker** — engine-level failure tracking with exponential backoff prevents cascading failures from broken CLIs
- **Rate limiting** — sliding-window rate limiter (100 req/min per IP) on embedded server
- **Council `defaultPermissionMode`** — new `CouncilConfig` option to override the `bypassPermissions` default for council agents
- **Shared constants module** — `src/constants.ts` consolidates 30+ magic numbers (timeouts, limits, thresholds) from across the codebase

### Changed
- **Council cleanup consolidation** — extracted `_cleanup()` method from `accept()` for reusable worktree/branch/file cleanup
- **Strongly typed event names** — `SESSION_EVENT` constant object replaces magic strings in event emission
- **Type cast fix** — eliminated `as unknown as` double cast in proxy handler registration

## [2.7.0] - 2026-04-04

### Added
- **Cursor Agent engine** — new `engine: 'cursor'` option wraps the Cursor Agent CLI (`agent`) with headless print mode, stream-json parsing, and full `ISession` interface support. Resolves #32
- `PersistentCursorSession` class (`src/persistent-cursor-session.ts`) implementing the same pattern as Codex/Gemini engines
- Unit tests for Cursor session (spawn flags, stream-json parsing, lifecycle, stderr sanitization)
- Cursor engine support in council agents — use `engine: 'cursor'` in agent personas for mixed-engine councils

## [2.6.1] - 2026-04-03

### Added
- **Zero-config proxy** — non-Claude models on the `claude` engine automatically start a local proxy server that converts Anthropic → OpenAI format and forwards to the OpenClaw gateway. Gateway port and auth are auto-detected from `~/.openclaw/openclaw.json`. No env vars, no baseUrl, no config changes needed
- Proxy documentation in `skills/references/multi-engine.md`

### Fixed
- **Proxy model URL extraction** — `extractRealModel` regex fixed to handle Claude Code CLI's `/real/<model>/v1/messages` URL pattern
- **Gateway model name** — `forwardToGateway` now sends `model: "openclaw"` as required by gateway
- **HEAD request handling** — proxy returns 200 for CLI probe requests instead of JSON parse errors

## [2.6.0] - 2026-04-03

### Changed
- **Skill restructure** — SKILL.md rewritten from scratch: removed hardcoded local paths, migrated metadata from `clawdis` to `openclaw` format, install via `kind: "node"` npm package instead of local path
- **Docs moved into skill** — `docs/` directory moved to `skills/references/` for progressive disclosure. AI agents load reference files on demand instead of duplicating content. All README/CLAUDE.md links updated
- **Skill description** — comprehensive trigger keywords covering all 27 tools, multi-engine, council, ultraplan, ultrareview

### Removed
- `docs/` directory (content lives in `skills/references/` now)
- Hardcoded `~/clawd/claude-code-skill` path from skill metadata

## [2.5.5] - 2026-04-03

### Fixed
- **Codex engine fully reworked** — migrated from `codex --full-auto --quiet` to `codex exec --full-auto --skip-git-repo-check -C <dir>`. Fixes `--quiet` rejection, `--cwd` rejection, TTY requirement, and git-repo-check in non-git directories (codex-cli 0.112.0+)
- **Gemini engine fake success** — non-zero exit codes (except 53/turn-limit) now correctly reject instead of resolving with empty output
- **Gemini prompt echo** — user-role messages from `stream-json` output are now filtered; only assistant responses are collected
- **Council consensus false positives** — removed loose tail-fallback heuristic that matched prompt instructions echoed back by agents. Only explicit `[CONSENSUS: YES/NO]` tags (and common variants) are accepted
- **Team tools fake execution** — `team_list` and `team_send` now reject with a clear error on non-Claude engines instead of sending raw text commands
- **Ultraplan error masking** — error responses (auth failures, empty output) no longer marked as `status: 'completed'` with error text in the `plan` field; correctly set `status: 'error'` with `error` field

### Added
- **Cross-engine team tools** — `team_list` and `team_send` now work on all engines. Claude uses native `/team` and `@teammate`; Codex/Gemini use SessionManager's cross-session messaging as a virtual team layer
- Engine Compatibility Matrix in README with tested CLI versions (Claude 2.1.91, Codex 0.118.0, Gemini 0.36.0)
- Known Limitations section in README
- Engine authentication prerequisites in docs/getting-started.md
- Full functional audit test script (`test-full-audit.ts`) — 47 tests covering all 27 tools across all 3 engines

### Changed
- Codex stdin set to `'ignore'` (was `'pipe'`) to prevent `codex exec` from waiting for piped input
- Consensus tail-fallback tests updated to match stricter parsing behavior

## [2.5.0] - 2026-04-03

### Added
- Council post-processing lifecycle: `council_review`, `council_accept`, `council_reject` tools — completes the council workflow with structured review, cleanup, and rejection-with-feedback
- `CouncilReviewResult`, `CouncilAcceptResult`, `CouncilRejectResult` types for structured post-processing responses
- Council `accepted` and `rejected` status states

### Changed
- Translated `configs/council-system-prompt.md` from Chinese to English for project-wide consistency
- Translated all Chinese strings in `council.ts` agent prompts and CLAUDE.md worktree templates to English
- `openclaw.plugin.json` contracts.tools updated from 24 → 27

## [2.4.0] - 2026-04-01

### Added
- Gemini CLI engine (`engine: 'gemini'`) — third engine alongside Claude Code and Codex. Per-message spawning with `--output-format stream-json` for real token usage tracking. Permission mapping: `bypassPermissions` → `--yolo`, `default` → `--sandbox` (#29)
- 88 new unit tests: SessionManager (74 tests, #28) and Gemini session (14 tests, #29). Total: 162 tests
- CLAUDE.md project context file for contributors
- README architecture diagram (mermaid), test badge, "Why not Claude API" callout

### Fixed
- Test files no longer compiled to `dist/` or shipped in npm package (tsconfig exclude)
- `openclaw.plugin.json` contracts.tools updated from 10 → 24 to match actual registered tools
- `SessionManagerLike` interface in council.ts uses real types instead of `Record<string, unknown>`
- CI switched from `npm install` to `npm ci` with committed lockfile for reproducible builds
- docs/cli.md: added SDK-only tools reference table (14 tools without CLI wrappers)

## [2.3.1] - 2026-04-01

### Fixed
- Plugin installation blocked on OpenClaw 2026.3.31 — resolved security scanner false positive for "credential harvesting" in CLI by deferring env var access (#24)
- Added `openclaw.hooks` declaration to prevent hook pack validation error
- Added `capabilities.childProcess` and `capabilities.networkAccess` to plugin manifest for scanner whitelisting

## [2.3.0] - 2026-03-31

### Added
- Session Inbox — cross-session messaging with `claude_session_send_to`, `claude_session_inbox`, `claude_session_deliver_inbox`. Idle sessions receive immediately; busy sessions queue for later delivery. Broadcast via `"*"` (#22)
- Ultraplan — dedicated Opus planning session (up to 30 min) with `ultraplan_start`, `ultraplan_status` (#22)
- Ultrareview — fleet of 5-20 specialized reviewer agents in parallel via council system with `ultrareview_start`, `ultrareview_status`. 20 review angles: security, logic, performance, types, concurrency, etc. (#22)
- Tool count: 17 → 24

### Fixed
- Session creation race condition — concurrent `startSession()` calls no longer create duplicates (#23)
- File persistence error handling — proper error callbacks, orphan `.tmp` cleanup on rename failure (#23)
- HTTP stream reader leak — `try/finally { reader.cancel() }` on all streaming paths (#23)
- CORS restricted to localhost origins only (#23)
- Agent name validation prevents git branch injection (#23)
- CWD path normalization via `path.resolve()` (#23)
- Session resume logic uses `??` instead of `||` for explicit null handling (#23)
- Stderr API key sanitization masks `sk-ant-*`, `*_API_KEY=*`, `Bearer *` patterns (#23)
- Council git errors now logged instead of silently swallowed (#23)
- SKILL.md cleaned up: removed 8 references to unimplemented CLI commands (#23)
- README tool count and CLI version accuracy (#23)

## [2.2.0] - 2026-03-31

### Added
- Stream output support — `onChunk` callback and `stream` param for `claude_session_send` (#9)
- Session persistence — registry saved to `~/.openclaw/claude-sessions.json` with 7-day disk TTL, atomic writes, debounced saves (#11)
- Dynamic tool/model switching — `claude_session_update_tools` and `claude_session_switch_model` with rollback on failure (#12)
- Session health overview — `claude_sessions_overview` tool for plugin-wide stats (#10)
- Premature CLI exit detection — startup crash no longer leaves sessions stuck in busy state (#13)

### Fixed
- Stale close listener on fallback ready path (follow-up to #13)
- Truncated code comments in startup flow

### Improved
- Project governance: CONTRIBUTING.md, CHANGELOG.md, issue/PR templates, CI workflows, npm publish automation

## [2.1.0] - 2026-03-31

### Added
- Cross-platform PATH inheritance from `process.env.PATH`
- `CLAUDE_BIN` env var override for custom binary locations
- `resumeSessionId` exposed in tool schema
- Lazy initialization — zero memory when unused

### Fixed
- `contextPercent` calculation (was hardcoded 0)
- Process blocking on detached child (`proc.unref()`)
- Ready event now listens for CLI init signal instead of blind 2s timeout

## [2.0.0] - 2026-03-31

### Added
- Complete rewrite as native OpenClaw plugin
- 10 native tools (`claude_session_start/send/stop/list/status/grep/compact`, `claude_agents_list`, `claude_team_list/send`)
- Plugin hooks: `before_prompt_build`, `registerHttpRoute`
- Embedded HTTP server for backward-compatible CLI access

### Breaking Changes
- Requires OpenClaw >= 2026.3.0 with plugin SDK
- Standalone Express backend deprecated
- FastAPI proxy now optional

## [1.2.0] - 2026-03-27

### Added
- Cost tracking per session
- Git branch awareness
- Hook system for pre/post execution
- Model aliases support

## [1.1.0] - 2026-03-25

### Added
- Effort levels (low/medium/high/max)
- Plan mode (`--plan` flag)
- Compact command for context reclamation
- Context percentage tracking
- Model switching within sessions

## [1.0.0] - 2026-03-23

### Added
- Initial release
- Persistent Claude Code sessions via MCP
- Multi-model proxy support
- Agent teams support
- SKILL.md for ClawHub discovery
