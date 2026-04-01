# CLAUDE.md — openclaw-claude-code

This file provides context for Claude Code when working on this project.

## Architecture

OpenClaw plugin that wraps coding CLIs (Claude Code, Codex, Gemini) into a
managed session layer. Key source files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry — registers all 24 tools with OpenClaw SDK |
| `src/session-manager.ts` | Core orchestrator — session lifecycle, inbox, council, ultraplan/ultrareview |
| `src/persistent-session.ts` | Claude Code CLI wrapper (spawn, JSON protocol, stream parsing) |
| `src/persistent-codex-session.ts` | Codex CLI wrapper (same ISession interface) |
| `src/persistent-gemini-session.ts` | Gemini CLI wrapper (stream-json, per-message spawning) |
| `src/council.ts` | Multi-agent collaboration engine with git worktree isolation |
| `src/consensus.ts` | Consensus voting parser for council |
| `src/types.ts` | All shared types, interfaces, model pricing |
| `src/embedded-server.ts` | HTTP server for standalone/CLI usage |
| `src/proxy/` | Multi-model proxy (Gemini, GPT via Anthropic format translation) |
| `bin/cli.ts` | CLI entry point (commander-based) |

## Development

```bash
npm run build          # TypeScript compilation (tsc)
npm run lint           # ESLint (src/ and bin/)
npm run format:check   # Prettier check
npm run test           # Vitest unit tests (src/__tests__/)
```

Integration test (requires Claude Code CLI installed):
```bash
npx tsx test-integration.ts
```

## Conventions

- **ESM only** — `"type": "module"` in package.json, `.js` extensions in imports
- **Strict TypeScript** — no `any` (eslint warns), full type annotations
- **Lazy initialization** — SessionManager created on first tool call, not at plugin load
- **Engine-agnostic** — all session engines implement `ISession` interface (types.ts)
- **Adding a new tool** — register in `src/index.ts`, add to `openclaw.plugin.json` contracts.tools, document in `docs/tools.md`

## Testing

- Unit tests live in `src/__tests__/*.test.ts` (vitest, no external dependencies)
- `test-integration.ts` is a manual smoke test requiring a live Claude Code CLI — not part of CI
- Tests are excluded from TypeScript compilation (tsconfig.json exclude) so they don't ship in dist/

## PR Guidelines

- Prefix: `feat:`, `fix:`, `docs:`, `chore:`, `test:`
- Run `npm run build && npm run lint && npm run test` before submitting
- Update CHANGELOG.md for user-facing changes
- Plugin installation requires `--dangerously-force-unsafe-install` (child_process usage)
