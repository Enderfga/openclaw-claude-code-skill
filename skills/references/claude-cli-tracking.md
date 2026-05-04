# Claude Code CLI Feature Tracking

This document tracks which Claude Code CLI version Claw Orchestrator is currently synced to, and which features have been integrated.

## Currently tracked: **Claude Code CLI 2.1.126** (as of 2026-05-04, plugin v2.14.2)

## Sync history

| Plugin Version | Claude CLI Version | Date | Notable integrations |
|---|---|---|---|
| v2.14.2 | 2.1.126 | 2026-05-04 | `bedrockServiceTier` (Bedrock service-tier env, 2.1.122), `claude_project_purge` tool (wraps `claude project purge`, 2.1.126); skipped passive-only items (OTel numeric attr, `invocation_trigger`, `/v1/models` gateway discovery, PowerShell shell changes) |
| v2.14.0 | 2.1.121 | 2026-04-28 | `forkSubagent` (fork subagent env), `enableToolSearch` (Vertex AI tool search env), `otelLogUserPrompts` / `otelLogRawApiBodies` (OTEL logging toggles), `xhigh` effort level (Opus 4.7), `stats.pluginErrors` capture from `system/init` |
| v2.13.0 | 2.1.111 | 2026-04-16 | Hook events, permission delegation, prompt cache optimization (exclude-dynamic-sections + 1H cache), debug control, `--from-pr`, MCP channels, `system/api_retry` event tracking |
| v2.12.2 and earlier | 2.1.91 | — | Bare mode, worktree, json-schema, mcp-config, betas, fallback-model, effort, agent teams |

## How to update this

When syncing to a new Claude Code CLI version:

1. Run `claude --version` to confirm target version
2. Check Claude Code changelog / release notes for new flags, events, env vars since the last tracked version
3. Decide which features are valuable for programmatic/agent use (vs human-interactive only) — see the Tier 1/2/3 framework in `docs/superpowers/specs/`
4. Implement worthwhile features (add to `SessionConfig` → wire into `persistent-session.ts` → expose in tool schema → document)
5. Update this file with the new version + notable integrations
6. Update `CLAUDE.md` and `README.md` engine compatibility tables
