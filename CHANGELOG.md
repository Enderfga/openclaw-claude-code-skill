# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
