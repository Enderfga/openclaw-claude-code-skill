# Claw Orchestrator Brand Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the repository from `openclaw-claude-code` (positioned as an OpenClaw plugin for Claude Code) to **Claw Orchestrator** (a multi-engine coding-agent orchestration runtime), without breaking existing installations during one transition release.

**Architecture:** This rebrand is split into three review-able parts:

- **Part A — Mechanical rename (Tasks 1–9):** Visual assets, package metadata, internal strings, log prefixes, CLI bin name (with old-name alias), skill name (with back-compat symlink), reference docs sweep, README rewrite. Low-risk find/replace plus a few small file moves.
- **Part B — API compatibility layer (Tasks 10–13):** Renaming the 17 `claude_*` tool names to engine-neutral names (`session_*`, `team_*`, `agents_*`, `project_*`), with deprecated aliases registered for one minor release. This is the only part that changes runtime behavior of the tool API. Reviewer should focus their attention here.
- **Part C — Release (Tasks 14–18):** Plugin id migration in `install.sh`, version bump to 3.0.0, CHANGELOG, build/lint/test verification, GitHub repo rename, npm deprecation of the old package, GitHub release.

**Tech Stack:** TypeScript (strict ESM), commander CLI, Vitest, npm, GitHub Actions, OpenClaw Plugin SDK.

**New canonical identifiers:**

| Aspect | Old | New |
|---|---|---|
| Product name | openclaw-claude-code / "Claude Code SDK" | **Claw Orchestrator** |
| npm package | `@enderfga/openclaw-claude-code` | `@enderfga/claw-orchestrator` |
| GitHub repo | `Enderfga/openclaw-claude-code` | `Enderfga/claw-orchestrator` |
| OpenClaw plugin id | `openclaw-claude-code` | `claw-orchestrator` |
| CLI binary | `claude-code-skill` | `clawo` (new) + `claude-code-skill` (alias, removed in 3.1) |
| Skill name | `claude-code-skill` | `claw-orchestrator` |
| Tool prefix | `claude_session_*`, `claude_team_*`, etc. | `session_*`, `team_*`, etc. (old names registered as deprecated aliases, removed in 3.1) |
| Log prefix | `[openclaw-claude-code]` | `[claw-orchestrator]` |
| Version | 2.15.0 | 3.0.0 |

**Things that stay the same:**

- `OPENCLAW_*` environment variables (correctly namespaced for OpenClaw integration; renaming creates ops churn)
- `peerDependencies.openclaw` (this still works as an OpenClaw plugin)
- `openclaw.plugin.json` filename (required by OpenClaw plugin loader)
- All `codex_*`, `council_*`, `ultraplan_*`, `ultrareview_*` tool names (already engine/scope-specific and engine-neutral)
- TypeScript public exports (`SessionManager`, `Council`, etc.)

---

## Part A — Mechanical Rename

### Task 1: Banner asset swap

**Files:**
- Create: `assets/banner.jpg` (overwrite — copy of new image)
- Create: `assets/banner-legacy.jpg` (preserve old for one release)

- [ ] **Step 1: Preserve the old banner**

```bash
cp assets/banner.jpg assets/banner-legacy.jpg
```

Run: `ls -la assets/`
Expected: shows both `banner.jpg` and `banner-legacy.jpg` (same size, ~42 KB).

- [ ] **Step 2: Replace banner with the new Claw Orchestrator image**

```bash
cp /Users/fanggan/tmp/img_1777876426895.jpg assets/banner.jpg
```

Run: `file assets/banner.jpg`
Expected: `JPEG image data, JFIF standard 1.01, ... 1672x941, components 3` (the new image dimensions).

- [ ] **Step 3: Verify the new banner renders**

Run: `qlmanage -p assets/banner.jpg >/dev/null 2>&1; echo $?`
Expected: `0` (Quick Look successfully opens the file). On non-macOS, skip this step and instead run `identify assets/banner.jpg` if ImageMagick is available, or just visually confirm.

- [ ] **Step 4: Commit**

```bash
git add assets/banner.jpg assets/banner-legacy.jpg
git commit -m "chore(brand): swap banner to Claw Orchestrator"
```

---

### Task 2: package.json metadata

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update name, version, description, keywords, repo URLs, bin map**

Replace the contents of `package.json` with:

```json
{
  "name": "@enderfga/claw-orchestrator",
  "version": "3.0.0",
  "description": "Claw Orchestrator — run Claude Code, Codex, Gemini, Cursor Agent and custom coding CLIs as one unified, programmable runtime. Persistent sessions, multi-agent council, tool orchestration.",
  "type": "module",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "bin": {
    "clawo": "./dist/bin/cli.js",
    "claude-code-skill": "./dist/bin/cli.js"
  },
  "openclaw": {
    "extensions": [
      "./dist/src/index.js"
    ],
    "hooks": {}
  },
  "files": [
    "dist/",
    "configs/",
    "skills/",
    "openclaw.plugin.json",
    "README.md",
    "LICENSE",
    "assets/banner.jpg"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ bin/",
    "lint:fix": "eslint src/ bin/ --fix",
    "format": "prettier --write 'src/**/*.ts' 'bin/**/*.ts'",
    "format:check": "prettier --check 'src/**/*.ts' 'bin/**/*.ts'",
    "prepublishOnly": "npm run build"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "keywords": [
    "claw-orchestrator",
    "coding-agent",
    "agent-orchestration",
    "claude-code",
    "codex",
    "gemini",
    "cursor",
    "multi-agent",
    "agent-council",
    "session-management",
    "openclaw",
    "mcp"
  ],
  "author": "enderfga",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Enderfga/claw-orchestrator.git"
  },
  "homepage": "https://github.com/Enderfga/claw-orchestrator#readme",
  "bugs": {
    "url": "https://github.com/Enderfga/claw-orchestrator/issues"
  },
  "license": "MIT",
  "dependencies": {
    "commander": "^12.1.0"
  },
  "peerDependencies": {
    "openclaw": ">=2026.3.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.15.0",
    "@types/node": "^22.10.0",
    "@vitest/coverage-v8": "^3.1.0",
    "eslint": "^9.15.0",
    "eslint-config-prettier": "^10.1.0",
    "prettier": "^3.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.20.0",
    "vitest": "^3.1.0"
  }
}
```

Note three deliberate changes beyond the rename: (a) `bin` exposes both `clawo` (canonical) and `claude-code-skill` (alias); (b) `assets/banner.jpg` added to `files` so the published package contains the banner for any registry that renders it; (c) keywords reordered so `claw-orchestrator` is first.

- [ ] **Step 2: Verify `package.json` is valid JSON and parses**

Run: `node -e "console.log(require('./package.json').name, require('./package.json').version)"`
Expected: `@enderfga/claw-orchestrator 3.0.0`

- [ ] **Step 3: Verify `npm install` still works (no dep changes, just metadata)**

Run: `npm install --no-audit --no-fund`
Expected: completes without errors. `node_modules/` is unchanged in shape.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(brand): rename npm package to @enderfga/claw-orchestrator (v3.0.0)"
```

---

### Task 3: openclaw.plugin.json

**Files:**
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Update id, name, description**

In `openclaw.plugin.json`, change these three top-level fields:

```json
{
  "id": "claw-orchestrator",
  "name": "Claw Orchestrator",
  "description": "Run Claude Code, Codex, Gemini, Cursor Agent and custom coding CLIs as one unified runtime. Persistent sessions, multi-engine orchestration, multi-agent council, worktree isolation, multi-model proxy, structured output, plan mode workflows.",
```

Leave the `configSchema`, `capabilities`, `contracts.tools`, and `skills` fields untouched in this task — `contracts.tools` is updated in Task 11 once new tool names exist.

- [ ] **Step 2: Verify JSON parses**

Run: `node -e "console.log(require('./openclaw.plugin.json').id)"`
Expected: `claw-orchestrator`

- [ ] **Step 3: Commit**

```bash
git add openclaw.plugin.json
git commit -m "chore(brand): rename openclaw plugin id to claw-orchestrator"
```

---

### Task 4: Internal log prefixes and inline source strings

**Files:**
- Modify: `src/index.ts:2-9` (file header docstring), `src/index.ts:63-66` (plugin id/name/desc), `src/index.ts:83`, `src/index.ts:86`, `src/index.ts:94-95` (registerService id + log lines)
- Modify: `src/types.ts:2`
- Modify: `src/persistent-codex-app-session.ts:215` (`clientInfo.name` and `version`)

- [ ] **Step 1: Update `src/index.ts` plugin object and log lines**

In `src/index.ts`, change line 2 (file header) from:

```
 * openclaw-claude-code — Plugin entry point
```

to:

```
 * claw-orchestrator — Plugin entry point
```

Change lines 63-66 from:

```ts
  id: 'openclaw-claude-code',
  name: 'Claude Code SDK',
  description:
    'Full-featured Claude Code integration — session management, agent teams, worktree isolation, multi-model proxy',
```

to:

```ts
  id: 'claw-orchestrator',
  name: 'Claw Orchestrator',
  description:
    'Run Claude Code, Codex, Gemini, Cursor Agent and custom coding CLIs as one unified runtime — persistent sessions, multi-agent council, worktree isolation, multi-model proxy',
```

Replace every `[openclaw-claude-code]` log prefix in this file with `[claw-orchestrator]`. There are exactly four occurrences (lines 83, 86, 95, plus the registerService id on line 94 which is a string id not a log prefix — change that too):

```ts
api.logger.info('[claw-orchestrator] First use — initialising SessionManager and embedded server');
// ...
server.start().catch((err) => api.logger.error('[claw-orchestrator] Embedded server failed to start:', err));
// ...
api.registerService({
  id: 'claw-orchestrator',
  start: () => api.logger.info('[claw-orchestrator] Plugin registered (lazy init — will activate on first use)'),
```

- [ ] **Step 2: Update `src/types.ts` file header**

Change line 2 from:

```
 * Shared types for openclaw-claude-code plugin
```

to:

```
 * Shared types for claw-orchestrator
```

- [ ] **Step 3: Update `src/persistent-codex-app-session.ts` clientInfo**

In `src/persistent-codex-app-session.ts:215`, change:

```ts
clientInfo: { name: 'openclaw-claude-code', title: null, version: '2.15.0' },
```

to:

```ts
clientInfo: { name: 'claw-orchestrator', title: null, version: '3.0.0' },
```

(The version is hard-coded for the Codex MCP handshake. Bumping it here keeps the wire identity in sync with package.json.)

- [ ] **Step 4: Verify no stale brand strings remain in `src/`**

Run: `grep -rn "openclaw-claude-code\|Claude Code SDK" src/ | grep -v __tests__`
Expected: no output.

- [ ] **Step 5: Build to confirm no type errors**

Run: `npm run build`
Expected: `tsc` exits 0, `dist/` rebuilt.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: all tests pass (the changes are pure string replacements; no test references these strings).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/types.ts src/persistent-codex-app-session.ts
git commit -m "chore(brand): update plugin id, log prefixes, and codex clientInfo to claw-orchestrator"
```

---

### Task 5: CLI binary rename with back-compat alias

**Files:**
- Modify: `bin/cli.ts:3` (header comment), `bin/cli.ts:8` (header comment), `bin/cli.ts:48` (`program.name(...)`)

- [ ] **Step 1: Update header comment**

In `bin/cli.ts`, replace lines 1-10 with:

```ts
#!/usr/bin/env node
/**
 * clawo CLI — connects to the Claw Orchestrator embedded server (auto-started by the plugin)
 *
 * When the plugin is installed, the embedded server starts automatically.
 * This CLI is just an HTTP client — zero configuration needed.
 *
 * For standalone use (no OpenClaw), run: clawo serve
 *
 * Note: this file is also exposed as `claude-code-skill` for backward
 * compatibility with v2.x installations. The alias will be removed in v3.1.
 */
```

- [ ] **Step 2: Update `program.name(...)` and description**

Change line 48 from:

```ts
program.name('claude-code-skill').description('Claude Code SDK CLI').version(getCliVersion());
```

to:

```ts
// Use argv[1] basename so the help text reflects which alias the user invoked
// (clawo vs. claude-code-skill). Both binaries point at this same file.
const invokedAs = (process.argv[1] || '').split('/').pop() || 'clawo';
program.name(invokedAs).description('Claw Orchestrator CLI').version(getCliVersion());
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `tsc` exits 0; `dist/bin/cli.js` is rebuilt.

- [ ] **Step 4: Verify the bin actually works under the new name**

Run from the repo: `node dist/bin/cli.js --version`
Expected: prints `3.0.0`.

Run: `node dist/bin/cli.js --help`
Expected: usage line starts with `Usage: cli.js [options] [command]` (the dynamic `invokedAs` resolves to whatever argv[1] is at runtime; under `node dist/bin/cli.js` invocation it'll show `cli.js`. After `npm install -g` it shows `clawo` or `claude-code-skill`).

- [ ] **Step 5: Verify alias is wired in package.json**

Run: `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.bin))"`
Expected: `{"clawo":"./dist/bin/cli.js","claude-code-skill":"./dist/bin/cli.js"}`

- [ ] **Step 6: Commit**

```bash
git add bin/cli.ts
git commit -m "feat(cli): rename CLI to clawo (claude-code-skill kept as alias for v3.0.x)"
```

---

### Task 6: Skill rename with back-compat symlink

**Files:**
- Modify: `skills/SKILL.md` (frontmatter `name`, references to old npm package name)
- Verify: `skills/claude-code-skill/SKILL.md` (already a symlink — preserve it)

- [ ] **Step 1: Inspect the existing symlink**

Run: `ls -la skills/claude-code-skill/`
Expected: contains a `SKILL.md` symlink pointing to `../SKILL.md` (or similar). Confirm with `readlink skills/claude-code-skill/SKILL.md`.

The symlink already serves as a back-compat path for OpenClaw skill loaders that scanned for `claude-code-skill/`. We keep it. The plan adds a parallel `skills/claw-orchestrator/` symlink so the new canonical name also resolves.

- [ ] **Step 2: Update `skills/SKILL.md` frontmatter `name`**

In `skills/SKILL.md`, change line 2:

```
name: claude-code-skill
```

to:

```
name: claw-orchestrator
```

In the same file, change the `package` field inside `metadata.openclaw.install[0]`:

```
"package": "@enderfga/openclaw-claude-code",
```

to:

```
"package": "@enderfga/claw-orchestrator",
```

Also change the H1 heading at the top of the body. Find:

```
# Claude Code Skill
```

Replace with:

```
# Claw Orchestrator Skill
```

And update the body's first paragraph if it self-identifies. Search for "Persistent multi-engine coding session manager. Wraps Claude Code, Codex, Gemini, and Cursor CLIs into headless agentic engines with 27 tools." Update the tool count if it's stale (re-count tools in `openclaw.plugin.json` `contracts.tools` — there are currently 33; after Part B aliases there will be 50, but skill-discoverable tool count should reflect canonical names: 33).

Replace the line with:

```
Claw Orchestrator — persistent multi-engine coding session manager. Wraps Claude Code, Codex, Gemini, and Cursor Agent CLIs (plus any custom CLI) into headless agentic engines with 33 tools.
```

- [ ] **Step 3: Add `skills/claw-orchestrator/` symlink**

```bash
ln -s ../SKILL.md skills/claw-orchestrator
```

Wait — that creates a symlink named `claw-orchestrator` pointing to `../SKILL.md`. But the existing `claude-code-skill/` is a directory containing a `SKILL.md` symlink. To match, do:

```bash
mkdir skills/claw-orchestrator
ln -s ../SKILL.md skills/claw-orchestrator/SKILL.md
```

Run: `ls -la skills/`
Expected: shows both `claude-code-skill/` and `claw-orchestrator/`, both with `SKILL.md` symlinks resolving to `../SKILL.md`.

Run: `cat skills/claw-orchestrator/SKILL.md | head -2`
Expected: starts with `---` and `name: claw-orchestrator` — i.e. follows the symlink to the canonical file.

- [ ] **Step 4: Commit**

```bash
git add skills/SKILL.md skills/claw-orchestrator/
git commit -m "feat(skill): rename to claw-orchestrator (claude-code-skill/ symlink kept for back-compat)"
```

---

### Task 7: Reference docs sweep (`skills/references/*.md`)

**Files:**
- Modify: every `.md` file under `skills/references/` that mentions `claude-code-skill`, `openclaw-claude-code`, "Claude Code SDK", or `@enderfga/openclaw-claude-code`

- [ ] **Step 1: Audit**

Run: `grep -rn "openclaw-claude-code\|claude-code-skill\|Claude Code SDK\|@enderfga/openclaw-claude-code" skills/references/`

Expected files (based on initial audit): `getting-started.md`, `cli.md`, `openai-compat.md`, possibly others. Save the file list to a scratch buffer; review each one in the next steps.

- [ ] **Step 2: Update `skills/references/getting-started.md`**

Replace every occurrence of `claude-code-skill` (the CLI name) with `clawo`. Replace `@enderfga/openclaw-claude-code` with `@enderfga/claw-orchestrator`. Where the doc shows a one-line install via `npm install -g`, update the package and binary name. Keep `OPENCLAW_*` env vars unchanged.

Example line 22 (`claude-code-skill serve`) becomes (`clawo serve`).
Example line 25 (`claude-code-skill session-start myproject -d ~/project`) becomes (`clawo session-start myproject -d ~/project`).
Example line 26-27: same pattern.

- [ ] **Step 3: Update `skills/references/cli.md`**

The doc opens with: "The CLI is an HTTP client that talks to the embedded server. In plugin mode, the server auto-starts. In standalone mode, run `claude-code-skill serve` first."

Replace with: "The CLI is an HTTP client that talks to the Claw Orchestrator embedded server. In plugin mode, the server auto-starts. In standalone mode, run `clawo serve` first. (The legacy `claude-code-skill` binary is still installed as an alias for one release; remove from scripts before upgrading to v3.1.)"

Update every `claude-code-skill <subcommand>` example to `clawo <subcommand>`.

- [ ] **Step 4: Update `skills/references/openai-compat.md`**

Only `OPENCLAW_*` env vars are mentioned here per the audit — those stay. But the doc may say "Claude Code SDK" in headers or descriptions. Search and replace per Step 1's audit list.

- [ ] **Step 5: Update tools.md cross-references**

`skills/references/tools.md` documents each tool. After Part B (Task 10–13) renames tools, this file gets a follow-up update. **In this task**, only update non-tool brand references (titles, intros, package names) — leave the tool-name table for Task 13.

- [ ] **Step 6: Re-audit**

Run: `grep -rn "openclaw-claude-code\|claude-code-skill\|Claude Code SDK" skills/references/`
Expected: no output (or only output that explicitly references the back-compat alias, e.g. lines added in Step 3 that say "the legacy `claude-code-skill` binary").

- [ ] **Step 7: Commit**

```bash
git add skills/references/
git commit -m "docs(brand): update references to Claw Orchestrator branding (clawo CLI, new package name)"
```

---

### Task 8: README rewrite

**Files:**
- Modify: `README.md` (full rewrite based on user-supplied draft, with badges/links restored)

- [ ] **Step 1: Replace README.md with the new structure**

Rewrite `README.md` end-to-end. The new file follows the user's draft structure with these adjustments: badge URLs point to the new repo; npm badge points to `@enderfga/claw-orchestrator`; the engine compatibility table from the old README is preserved; `clawo` is the canonical CLI; OpenClaw is presented as one supported integration path (after standalone usage), not the lead identity.

Final `README.md` content:

````markdown
<p align="center">
  <img src="./assets/banner.jpg" alt="Claw Orchestrator" width="100%">
</p>

# Claw Orchestrator

Run Claude Code, Codex and other coding agents in one unified runtime.

Claw Orchestrator turns interactive coding CLIs into programmable, headless agent engines. Start persistent sessions, route tasks across different coding agents, coordinate multi-agent councils, and expose everything through a clean tool-based API.

> Claude Code, Codex, Gemini, Cursor Agent, or your own custom CLI — orchestrated as one runtime.

[![npm version](https://img.shields.io/npm/v/@enderfga/claw-orchestrator.svg)](https://www.npmjs.com/package/@enderfga/claw-orchestrator)
[![CI](https://github.com/Enderfga/claw-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/Enderfga/claw-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Why Claw Orchestrator?

Coding agents are powerful, but most are still designed as interactive CLIs.

That works well when a human is sitting in front of a terminal. It breaks down when you want agents to:

- keep long-running coding sessions alive
- switch between Claude Code, Codex, Gemini, Cursor Agent, or custom CLIs
- collaborate as a team on the same codebase
- expose coding capabilities to OpenClaw, MCP, bots, dashboards, or other agent systems
- manage context, tools, worktrees, and execution state programmatically

Claw Orchestrator is the control layer for that.

---

## Core Features

### Persistent Sessions

Keep coding agents alive across requests.

```ts
const session = await manager.startSession({
  name: "fix-tests",
  engine: "claude",
  cwd: "/path/to/project",
});

await manager.sendMessage("fix-tests", "Fix the failing tests");
```

### Multi-Engine Runtime

Drive different coding agents through one unified interface.

```ts
await manager.startSession({ name: "claude-task", engine: "claude" });
await manager.startSession({ name: "codex-task",  engine: "codex"  });
await manager.startSession({ name: "gemini-task", engine: "gemini" });
await manager.startSession({ name: "cursor-task", engine: "cursor" });
```

### Multi-Agent Council

Run multiple agents in parallel with isolated git worktrees, independent reasoning, and review-based collaboration.

```ts
await manager.councilStart("Design and implement an auth system", {
  agents: [
    { name: "Planner",  engine: "claude" },
    { name: "Builder",  engine: "codex"  },
    { name: "Reviewer", engine: "claude" },
  ],
});
```

### Tool Orchestration

Expose coding sessions as tools so other agents and systems can control them. The runtime registers 33 tools, including:

```txt
session_start         session_send         session_status
session_grep          session_compact      session_inbox
team_send             team_list            agents_list
council_start         council_review       council_accept
ultraplan_start       ultrareview_start
```

(For backward compatibility with v2.x callers, the legacy `claude_session_*` aliases remain registered through v3.0.x and will be removed in v3.1.)

---

## Quick Start

### Standalone (no OpenClaw)

```bash
npm install -g @enderfga/claw-orchestrator
clawo serve
```

```bash
clawo session start --engine claude --name fix-tests --cwd .
clawo session send fix-tests "Fix the failing tests"
```

### Programmatic

```ts
import { SessionManager } from "@enderfga/claw-orchestrator";

const manager = new SessionManager();
await manager.startSession({ name: "task", cwd: "/project" });
const result = await manager.sendMessage("task", "Fix the failing tests");
```

### Run a multi-agent council

```bash
clawo council start "Refactor the API layer and add tests"
```

### As an OpenClaw plugin

If you run OpenClaw, Claw Orchestrator installs as a managed plugin. The same tools (`session_start`, `team_send`, `council_start`, ...) become available to every OpenClaw agent.

```bash
curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
```

This installs via npm, registers the plugin in `~/.openclaw/openclaw.json`, and restarts the gateway. See [`skills/references/getting-started.md`](./skills/references/getting-started.md) for the full setup, including upgrading from `openclaw-claude-code` v2.x.

---

## Engine Compatibility

| Engine | CLI | Tested Version | Status |
|--------|-----|----------------|--------|
| Claude Code   | `claude` | 2.1.126     | Supported |
| Codex         | `codex`  | 0.128.0     | Supported |
| Gemini        | `gemini` | 0.36.0      | Supported |
| Cursor Agent  | `agent`  | 2026.03.30  | Supported |
| Custom CLI    | any      | —           | Supported |

Any coding CLI that can run as a subprocess can be integrated as a custom engine.

---

## Architecture

```txt
                 ┌─────────────────────┐
                 │  Claw Orchestrator  │
                 └──────────┬──────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
 ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
 │ Claude Code │     │    Codex    │     │ Custom CLI  │
 └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
        │                   │                   │
        └───────────┬───────┴───────────┬───────┘
                    │                   │
             Persistent Sessions   Tool API
                    │                   │
                    └──── Multi-Agent Council
```

For source-level architecture, see [`CLAUDE.md`](./CLAUDE.md). For deeper reference docs, see [`skills/references/`](./skills/references/).

---

## Migrating from `@enderfga/openclaw-claude-code` (v2.x)

v3.0 renames the package, the CLI binary, and the tool API.

| What | v2.x | v3.0 |
|---|---|---|
| npm package | `@enderfga/openclaw-claude-code` | `@enderfga/claw-orchestrator` |
| CLI binary | `claude-code-skill` | `clawo` (the old name still works in v3.0.x) |
| Tool names | `claude_session_start`, `claude_session_send`, ... | `session_start`, `session_send`, ... (old names still work in v3.0.x) |
| OpenClaw plugin id | `openclaw-claude-code` | `claw-orchestrator` |

To upgrade:

```bash
npm uninstall -g @enderfga/openclaw-claude-code
npm install -g @enderfga/claw-orchestrator
# If you use OpenClaw, the install.sh handles the plugin entry migration:
curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
```

The legacy aliases (`claude-code-skill` binary and `claude_*` tool names) remain registered for the duration of v3.0.x. They will be removed in v3.1; update your scripts before upgrading.

---

## Project Status

Active development. Current focus areas:

- stable multi-engine session management
- richer council workflows
- custom engine configuration ergonomics
- runtime control APIs
- cleaner CLI and OpenClaw integration

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). PR prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) are required. Run `npm run build && npm run lint && npm run format:check && npm run test` before submitting.

---

## License

MIT — see [`LICENSE`](./LICENSE).
````

- [ ] **Step 2: Verify all internal links resolve**

Run: `grep -oE '\[.*?\]\([^)]+\)' README.md | grep -v "https://" | grep -v "mailto:"`
Expected: only relative links (`./CLAUDE.md`, `./skills/references/...`, `./CONTRIBUTING.md`, `./LICENSE`, `./assets/banner.jpg`). Spot-check each path exists with `ls`.

- [ ] **Step 3: Verify the markdown renders cleanly**

Run: `npx markdown-link-check README.md 2>&1 | tail -20` (if available; otherwise skip).
Or open in VS Code preview / GitHub markdown rendering and visually confirm.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(brand): rewrite README for Claw Orchestrator (engine-orchestrator-first positioning)"
```

---

### Task 9: install.sh and CONTRIBUTING.md

**Files:**
- Modify: `install.sh`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Update `install.sh` constants and URLs**

In `install.sh`, change:

```bash
# One-line installer for openclaw-claude-code
# Usage: curl -fsSL https://raw.githubusercontent.com/Enderfga/openclaw-claude-code/main/install.sh | bash
set -euo pipefail

NPM_PACKAGE="@enderfga/openclaw-claude-code"
```

to:

```bash
# One-line installer for Claw Orchestrator
# Usage: curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
set -euo pipefail

NPM_PACKAGE="@enderfga/claw-orchestrator"
LEGACY_PACKAGE="@enderfga/openclaw-claude-code"
LEGACY_PLUGIN_ID="openclaw-claude-code"
```

The plugin id migration (replacing the legacy id with the new one in `~/.openclaw/openclaw.json`) is implemented in Task 14, not here. This task only updates the static strings.

Find the `if p.endswith('/openclaw-claude-code'):` block (around line 56) and update it to also accept the new path:

```python
    if p.endswith('/openclaw-claude-code') or p.endswith('/claw-orchestrator'):
```

Find the `if 'openclaw-claude-code' in entries:` block (around line 67) — leave it for now (this is the entry-stripping logic for an old `plugins.entries.<id>` config style and remains correct in this task; Task 14 augments it).

Find the success message (`ok "openclaw-claude-code is loaded and ready!"`) and replace with:

```bash
    ok "Claw Orchestrator is loaded and ready!"
```

Find the docs URL at the bottom and replace with:

```bash
echo "  Docs: https://github.com/Enderfga/claw-orchestrator"
```

- [ ] **Step 2: Verify `install.sh` shellcheck-clean**

Run: `shellcheck install.sh` (if available)
Expected: no errors. If shellcheck is unavailable, run `bash -n install.sh` to syntax-check.

- [ ] **Step 3: Update `CONTRIBUTING.md`**

Search and replace:
- `openclaw-claude-code` → `claw-orchestrator` (everywhere)
- `claude-code-skill` (the CLI name) → `clawo`
- "Claude Code SDK" → "Claw Orchestrator"
- `@enderfga/openclaw-claude-code` → `@enderfga/claw-orchestrator`

Run: `grep -n "openclaw-claude-code\|claude-code-skill\|Claude Code SDK" CONTRIBUTING.md`
Expected: no output (or only intentional historical references).

- [ ] **Step 4: Commit**

```bash
git add install.sh CONTRIBUTING.md
git commit -m "docs(brand): update install.sh and CONTRIBUTING.md to Claw Orchestrator"
```

---

## Part B — API Compatibility Layer

> **Reviewer focus:** This part actually changes runtime behavior of the public tool API. It introduces 17 new canonical tool names and registers the 17 old `claude_*` names as deprecated aliases. After Part B, callers of either old or new names continue to work; the alias registrations are scheduled for removal in v3.1.

### Task 10: Add a `registerToolWithAliases` helper in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (add helper just above the first `api.registerTool` call, around line 126)

The 17 affected tools are currently registered with literal `api.registerTool({ ... })` calls. To minimize per-tool diff size and centralize the deprecation message format, we add one helper that takes a canonical tool definition plus a list of deprecated aliases.

- [ ] **Step 1: Add the helper after the proxy HTTP route registration block**

Insert this immediately after line 124 (the closing brace of the `if (rawConfig.proxy?.enabled !== false) { ... }` block) and before line 126 (the `// ─── Tool: claude_session_start ──────────────────────────────────────` comment):

```ts
    // ─── Tool registration helper ─────────────────────────────────────────
    //
    // In v3.0 we renamed the engine-coupled `claude_*` tools to engine-neutral
    // names (`session_*`, `team_*`, etc.). The old names remain registered as
    // deprecated aliases for one minor release and will be removed in v3.1.
    //
    // The alias's description is prefixed with `[DEPRECATED]` and the new
    // name so any agent reading the tool list gets a clear hint to migrate.
    function registerToolWithAliases(
      def: Parameters<PluginAPI['registerTool']>[0],
      deprecatedAliases: string[] = []
    ): void {
      api.registerTool(def);
      for (const alias of deprecatedAliases) {
        api.registerTool({
          ...def,
          name: alias,
          description: `[DEPRECATED — use ${def.name}; this alias is removed in v3.1] ${def.description}`,
        });
      }
    }
```

- [ ] **Step 2: Verify build still passes (no consumers yet)**

Run: `npm run build`
Expected: `tsc` exits 0. The helper is unused but typed.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(tools): add registerToolWithAliases helper for v3.0 → v3.1 deprecation aliases"
```

---

### Task 11: Rename the 17 `claude_*` tools to engine-neutral names

**Files:**
- Modify: `src/index.ts` (every `api.registerTool({ name: 'claude_...' ... })` call)
- Modify: `openclaw.plugin.json` (`contracts.tools` array)

The full mapping (verify against `grep -n "claude_" src/index.ts`):

| Old name (alias) | New name (canonical) |
|---|---|
| `claude_session_start` | `session_start` |
| `claude_session_send` | `session_send` |
| `claude_session_stop` | `session_stop` |
| `claude_session_list` | `session_list` |
| `claude_sessions_overview` | `sessions_overview` |
| `claude_session_status` | `session_status` |
| `claude_session_grep` | `session_grep` |
| `claude_session_compact` | `session_compact` |
| `claude_agents_list` | `agents_list` |
| `claude_team_list` | `team_list` |
| `claude_team_send` | `team_send` |
| `claude_session_update_tools` | `session_update_tools` |
| `claude_session_switch_model` | `session_switch_model` |
| `claude_project_purge` | `project_purge` |
| `claude_session_send_to` | `session_send_to` |
| `claude_session_inbox` | `session_inbox` |
| `claude_session_deliver_inbox` | `session_deliver_inbox` |

**The `codex_*`, `council_*`, `ultraplan_*`, `ultrareview_*` tools are NOT renamed.**

- [ ] **Step 1: Convert the first tool registration as the pattern**

Find the `// ─── Tool: claude_session_start ──────────────────────────────────────` block (lines 126-289). Change the comment to `// ─── Tool: session_start ──────────────────────────────────────` and change the `api.registerTool({` call to `registerToolWithAliases({`. Change the `name:` field from `'claude_session_start'` to `'session_start'`. After the closing `})` of the registerTool argument, add the alias array. The result looks like:

```ts
    // ─── Tool: session_start ──────────────────────────────────────
    registerToolWithAliases({
      name: 'session_start',
      description:
        '...',  // (existing description, unchanged)
      parameters: {
        // (existing schema, unchanged)
      },
      execute: async (toolCallId, params) => {
        // (existing handler body, unchanged)
      },
    }, ['claude_session_start']);
```

- [ ] **Step 2: Run build to confirm one tool conversion compiles**

Run: `npm run build`
Expected: 0 errors. The runtime now exposes both `session_start` (canonical) and `claude_session_start` (deprecated alias).

- [ ] **Step 3: Repeat the conversion for the remaining 16 tools**

For each of the 16 remaining `api.registerTool` calls registering a `claude_*`-prefixed tool, perform the same three-edit pattern: (1) update the section comment header to the new name, (2) change `api.registerTool` → `registerToolWithAliases`, (3) change the `name:` field to the canonical name, (4) append the deprecated-alias array as the second argument.

Process them in the order they appear in the file. After each conversion, save and re-run `npm run build` to keep the diff bisectable. Suggested commit cadence: one commit per group (sessions group, team/agents group, advanced group, inbox group) to keep the review surface small.

- [ ] **Step 4: Update internal cross-references in tool descriptions**

A few tool descriptions reference other tool names. After the renames, scan for stale internal references:

```bash
grep -n "claude_session\|claude_team\|claude_agents\|claude_project" src/index.ts | grep -v "registerToolWithAliases" | grep -v "DEPRECATED"
```

Expected: only the alias array literals (the second argument to `registerToolWithAliases`) should still mention `claude_*` names. If any tool description's prose still says "use claude_session_status instead", update it to "use session_status instead". Specifically check line 371's old wording: "For single-session detail, use claude_session_status instead." → "For single-session detail, use session_status instead."

- [ ] **Step 5: Update `openclaw.plugin.json` `contracts.tools`**

Replace the `contracts.tools` array. The new array lists all canonical names plus all deprecated aliases (50 entries total: 33 canonical + 17 aliases). Reason: OpenClaw uses this list for tool discovery and access control; both old and new names must be discoverable while the alias is supported.

```json
  "contracts": {
    "tools": [
      "session_start",
      "session_send",
      "session_stop",
      "session_list",
      "sessions_overview",
      "session_status",
      "session_grep",
      "session_compact",
      "agents_list",
      "team_list",
      "team_send",
      "session_update_tools",
      "session_switch_model",
      "project_purge",
      "codex_resume",
      "codex_review",
      "codex_goal_set",
      "codex_goal_get",
      "codex_goal_pause",
      "codex_goal_resume",
      "codex_goal_clear",
      "council_start",
      "council_status",
      "council_abort",
      "council_inject",
      "council_review",
      "council_accept",
      "council_reject",
      "session_send_to",
      "session_inbox",
      "session_deliver_inbox",
      "ultraplan_start",
      "ultraplan_status",
      "ultrareview_start",
      "ultrareview_status",
      "claude_session_start",
      "claude_session_send",
      "claude_session_stop",
      "claude_session_list",
      "claude_sessions_overview",
      "claude_session_status",
      "claude_session_grep",
      "claude_session_compact",
      "claude_agents_list",
      "claude_team_list",
      "claude_team_send",
      "claude_session_update_tools",
      "claude_session_switch_model",
      "claude_project_purge",
      "claude_session_send_to",
      "claude_session_inbox",
      "claude_session_deliver_inbox"
    ]
  },
```

- [ ] **Step 6: Verify no `claude_*` names remain as canonical**

Run: `grep -n "name: 'claude_" src/index.ts`
Expected: no output. (All `claude_*` mentions should now appear only as alias-array literals.)

Run: `grep -nE "registerTool\(\{|registerToolWithAliases\(\{" src/index.ts | wc -l`
Expected: `33` (one canonical registration per tool).

- [ ] **Step 7: Build and run tests**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass. (No tests reference tool names by string, per audit.)

- [ ] **Step 8: Commit**

If you committed in groups during Step 3, the final commit here is for `openclaw.plugin.json` only:

```bash
git add openclaw.plugin.json
git commit -m "feat(tools): expose v3.0 canonical tool names + v2.x aliases in plugin contracts"
```

Otherwise commit the whole rename in one shot:

```bash
git add src/index.ts openclaw.plugin.json
git commit -m "feat(tools): rename claude_* tools to engine-neutral names (claude_* kept as deprecated aliases through v3.0.x)"
```

---

### Task 12: Add a sanity test for tool registration and aliases

**Files:**
- Create: `src/__tests__/tool-registration.test.ts`

The runtime correctness of the rename hinges on three things: every canonical name is registered, every deprecated alias is registered, and each alias's description is marked `[DEPRECATED]`. Lock these with a test so accidental future deletions are caught.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/tool-registration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import plugin from '../index.js';

interface RegisteredTool {
  name: string;
  description: string;
}

function collectRegisteredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  // Minimal stub PluginAPI — just enough to capture registerTool calls.
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: { name: string; description: string }) => {
      tools.push({ name: def.name, description: def.description });
    },
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  // The plugin's `register` method takes the api object and registers tools synchronously.
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return tools;
}

const CANONICAL_RENAMED_TOOLS = [
  'session_start', 'session_send', 'session_stop', 'session_list',
  'sessions_overview', 'session_status', 'session_grep', 'session_compact',
  'agents_list', 'team_list', 'team_send', 'session_update_tools',
  'session_switch_model', 'project_purge', 'session_send_to',
  'session_inbox', 'session_deliver_inbox',
];

const DEPRECATED_ALIASES = CANONICAL_RENAMED_TOOLS.map((n) => `claude_${n}`);

describe('plugin tool registration', () => {
  const tools = collectRegisteredTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  it('registers all canonical engine-neutral tool names', () => {
    for (const name of CANONICAL_RENAMED_TOOLS) {
      expect(byName.has(name), `missing canonical tool: ${name}`).toBe(true);
    }
  });

  it('registers all v2.x deprecated aliases', () => {
    for (const alias of DEPRECATED_ALIASES) {
      expect(byName.has(alias), `missing alias: ${alias}`).toBe(true);
    }
  });

  it('marks every deprecated alias with [DEPRECATED] in its description', () => {
    for (const alias of DEPRECATED_ALIASES) {
      const tool = byName.get(alias);
      expect(tool?.description).toMatch(/\[DEPRECATED/);
    }
  });

  it('keeps codex_*, council_*, ultra* tool names unchanged', () => {
    const unchanged = [
      'codex_resume', 'codex_review',
      'codex_goal_set', 'codex_goal_get', 'codex_goal_pause', 'codex_goal_resume', 'codex_goal_clear',
      'council_start', 'council_status', 'council_abort', 'council_inject',
      'council_review', 'council_accept', 'council_reject',
      'ultraplan_start', 'ultraplan_status',
      'ultrareview_start', 'ultrareview_status',
    ];
    for (const name of unchanged) {
      expect(byName.has(name), `missing unchanged tool: ${name}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test (expect: all four cases pass after Task 11)**

Run: `npm test -- tool-registration.test.ts`
Expected: 4 tests pass. If any fail, the most likely cause is that Task 11 missed a tool — fix the source, do not loosen the test.

If `plugin` is not the default export (verify by reading the bottom of `src/index.ts`), adjust the import in the test:

```ts
import plugin from '../index.js';
// or:
import { plugin } from '../index.js';
// or read the file's actual export structure and match it.
```

If `src/index.ts` doesn't currently default-export the plugin object, add `export default plugin;` at the bottom of the file in this task. (Verify it doesn't break any external consumer — search for `import plugin from '@enderfga/openclaw-claude-code'` across user code; if no consumers, this export is purely for the test.)

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/tool-registration.test.ts src/index.ts
git commit -m "test(tools): lock canonical tool names and v2.x aliases against accidental removal"
```

---

### Task 13: Update `skills/references/tools.md` for new tool names

**Files:**
- Modify: `skills/references/tools.md`

- [ ] **Step 1: Update tool documentation table**

In `skills/references/tools.md`, every section that documents a `claude_*` tool needs:
1. Section heading renamed to the canonical name.
2. Description updated to use the new name.
3. A small "Aliased from `claude_<name>` (deprecated, removed in v3.1)" line added below the heading for each renamed tool.
4. Examples that show calling the tool by name updated to the canonical name.

Apply the rename mapping from Task 11 systematically. Process each section in the file in order.

- [ ] **Step 2: Add a top-of-file migration note**

At the top of `skills/references/tools.md`, just after any existing intro paragraph, add:

```markdown
> **v3.0 rename:** Tools previously prefixed with `claude_` are now engine-neutral (e.g. `claude_session_start` → `session_start`). The old names remain registered as deprecated aliases through v3.0.x and will be removed in v3.1. New code should use the canonical names below.
```

- [ ] **Step 3: Re-audit**

Run: `grep -n "claude_session\|claude_team\|claude_agents\|claude_project" skills/references/tools.md`
Expected: only matches in the alias-mention lines you added in Step 1 ("Aliased from `claude_...`") and the migration note in Step 2. No "use claude_session_start" prose.

- [ ] **Step 4: Commit**

```bash
git add skills/references/tools.md
git commit -m "docs(tools): document new canonical tool names and v2.x deprecated aliases"
```

---

## Part C — Release

### Task 14: Plugin id migration in `install.sh`

**Files:**
- Modify: `install.sh`

The OpenClaw config file `~/.openclaw/openclaw.json` may already contain a stale `plugins.entries.openclaw-claude-code` entry from a prior v2.x install. We strip that and ensure the new path is registered.

- [ ] **Step 1: Read the current `install.sh` python block**

Run: `sed -n '50,100p' install.sh`
Note the existing logic that resolves `PKG_PATH`, scans `plugins.load.paths`, and removes stale `plugins.entries`.

- [ ] **Step 2: Extend the python block to migrate the legacy entry**

Inside the python block in `install.sh`, after the existing entry-strip logic (the section that does `if 'openclaw-claude-code' in entries: del entries[...]`), add:

```python
# v3.0 plugin id migration: scrub stale plugins.load.paths entries that
# still point at the old v2.x install path
load_paths = config.setdefault('plugins', {}).setdefault('load', {}).setdefault('paths', [])
new_load_paths = []
for p in load_paths:
    if p.endswith('/openclaw-claude-code'):
        print(f'Removing stale v2.x load path: {p}')
        continue
    new_load_paths.append(p)
config['plugins']['load']['paths'] = new_load_paths
```

(Keep the existing path-append logic that adds the new `${PKG_PATH}` to `plugins.load.paths`.)

- [ ] **Step 3: Add a clear pre-install note about the legacy npm package**

Just after `info "Installing ${NPM_PACKAGE} via npm..."`, add:

```bash
# Warn if the legacy v2.x package is still globally installed.
if npm ls -g --depth=0 --json 2>/dev/null | grep -q '"@enderfga/openclaw-claude-code"'; then
    warn "${LEGACY_PACKAGE} is still installed globally. After this script finishes, run:"
    warn "    npm uninstall -g ${LEGACY_PACKAGE}"
fi
```

- [ ] **Step 4: Verify the python block parses**

Run: `bash -n install.sh && python3 -c "import ast; ast.parse(open('install.sh').read().split('python3 -c', 1)[1].split(chr(34)*1, 2)[1] if False else 'pass')"` — easier: extract the heredoc and validate manually. Practically: shellcheck should flag any obvious issue, and a real run on a test config is the actual verification.

- [ ] **Step 5: Smoke-test against a fake config**

```bash
# Set up a temp openclaw.json with a stale legacy entry
TMPDIR=$(mktemp -d)
cat > "$TMPDIR/openclaw.json" <<'EOF'
{
  "plugins": {
    "load": { "paths": ["/old/path/to/openclaw-claude-code"] },
    "entries": { "openclaw-claude-code": { "enabled": true } }
  }
}
EOF
HOME=$TMPDIR bash -c 'mkdir -p ~/.openclaw && cp "$1/openclaw.json" ~/.openclaw/openclaw.json' _ "$TMPDIR"
# Invoke just the python block manually with PKG_PATH set to a fake new path:
PKG_PATH="/new/path/to/claw-orchestrator" CONFIG_FILE="$TMPDIR/openclaw.json" python3 -c '
import json, os
with open(os.environ["CONFIG_FILE"]) as f:
    config = json.load(f)
# (paste the migration block here for ad-hoc test)
print(json.dumps(config, indent=2))
'
```

Expected: the printed config has `plugins.load.paths` containing only `/new/path/to/claw-orchestrator` and no `plugins.entries.openclaw-claude-code`.

- [ ] **Step 6: Commit**

```bash
git add install.sh
git commit -m "feat(install): migrate legacy openclaw-claude-code plugin entry on upgrade"
```

---

### Task 15: CHANGELOG.md entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a new top section for v3.0.0**

Insert at the top of `CHANGELOG.md` (above the existing v2.15.0 section):

```markdown
## [3.0.0] - 2026-05-04

### Brand Rebrand

- Project renamed from **openclaw-claude-code** ("Claude Code SDK") to **Claw Orchestrator**.
- npm package renamed: `@enderfga/openclaw-claude-code` → `@enderfga/claw-orchestrator`. The old package has been deprecated on npm with a moved-to message.
- GitHub repository renamed: `Enderfga/openclaw-claude-code` → `Enderfga/claw-orchestrator`. GitHub auto-redirects existing URLs and clones; `install.sh` raw URL is now `https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh`.
- OpenClaw plugin id renamed: `openclaw-claude-code` → `claw-orchestrator`. The new `install.sh` strips legacy v2.x entries from `~/.openclaw/openclaw.json` automatically on upgrade.
- CLI binary renamed: `claude-code-skill` → `clawo`. The old binary remains installed as an alias for the v3.0.x line and will be removed in v3.1.
- Skill name renamed: `claude-code-skill` → `claw-orchestrator`. The `skills/claude-code-skill/` directory is preserved as a back-compat symlink for the v3.0.x line.
- Banner updated; the v2.x banner is preserved at `assets/banner-legacy.jpg`.
- Log prefixes updated from `[openclaw-claude-code]` to `[claw-orchestrator]`.

### Breaking — Tool API rename (with deprecation aliases)

The 17 `claude_*`-prefixed tools were renamed to engine-neutral names. The old names remain registered as deprecated aliases for the v3.0.x line and will be removed in v3.1. The `codex_*`, `council_*`, `ultraplan_*`, `ultrareview_*` tool names are unchanged.

| Old name (alias, deprecated) | New name (canonical) |
|---|---|
| `claude_session_start` | `session_start` |
| `claude_session_send` | `session_send` |
| `claude_session_stop` | `session_stop` |
| `claude_session_list` | `session_list` |
| `claude_sessions_overview` | `sessions_overview` |
| `claude_session_status` | `session_status` |
| `claude_session_grep` | `session_grep` |
| `claude_session_compact` | `session_compact` |
| `claude_agents_list` | `agents_list` |
| `claude_team_list` | `team_list` |
| `claude_team_send` | `team_send` |
| `claude_session_update_tools` | `session_update_tools` |
| `claude_session_switch_model` | `session_switch_model` |
| `claude_project_purge` | `project_purge` |
| `claude_session_send_to` | `session_send_to` |
| `claude_session_inbox` | `session_inbox` |
| `claude_session_deliver_inbox` | `session_deliver_inbox` |

Calling a deprecated name still works; the tool description in OpenClaw's tool listing is prefixed with `[DEPRECATED — use <new-name>; this alias is removed in v3.1]` to nudge migration.

### Migration Guide

```bash
# 1. Uninstall the old package
npm uninstall -g @enderfga/openclaw-claude-code

# 2. Install the new package
npm install -g @enderfga/claw-orchestrator

# 3. (If you use OpenClaw) re-run install.sh to migrate the plugin entry
curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
```

Update any scripts that invoke the CLI by name from `claude-code-skill` to `clawo`. Tool callers in agents/MCP clients can continue using `claude_*` names through v3.0.x but should plan to migrate to the engine-neutral names before upgrading to v3.1.

### Unchanged

- `OPENCLAW_*` environment variables (`OPENCLAW_LOG_LEVEL`, `OPENCLAW_SERVE_MAX_SESSIONS`, `OPENCLAW_SERVE_TTL_MINUTES`, `OPENCLAW_RATE_LIMIT`, `OPENCLAW_CORS_ORIGINS`, `OPENCLAW_SERVER_TOKEN`)
- TypeScript public exports (`SessionManager`, `Council`, `PersistentClaudeSession`, etc.)
- `peerDependencies.openclaw` requirement
- Engine compatibility (Claude Code 2.1.126, Codex 0.128.0, Gemini 0.36.0, Cursor Agent 2026.03.30)
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): document v3.0.0 brand rebrand and tool API rename"
```

---

### Task 16: Update CLAUDE.md (project instructions)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update brand strings in `CLAUDE.md`**

The project-level `CLAUDE.md` opens with a sentence about the project's identity. Find:

```
# CLAUDE.md — openclaw-claude-code
```

Replace with:

```
# CLAUDE.md — claw-orchestrator
```

Find the architecture line:

```
OpenClaw plugin that wraps coding CLIs (Claude Code, Codex, Gemini, Cursor) into a
managed session layer.
```

Replace with:

```
Claw Orchestrator wraps coding CLIs (Claude Code, Codex, Gemini, Cursor Agent, plus
arbitrary custom CLIs) into a managed, programmable session layer. Runs standalone
or as an OpenClaw plugin.
```

In the **Engine CLI Reference** section (near the bottom), no changes are needed — the table is correct as-is.

In the **PR Guidelines** section, no changes are needed.

In the **Release Process** section, the version bump example is fine; no changes.

- [ ] **Step 2: Re-audit**

Run: `grep -n "openclaw-claude-code\|claude-code-skill\|Claude Code SDK" CLAUDE.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(brand): update CLAUDE.md to Claw Orchestrator identity"
```

---

### Task 17: Final pre-flight verification

This task runs the full release pre-flight one last time before tagging. No code changes — just verification.

- [ ] **Step 1: Clean install and build**

```bash
rm -rf node_modules dist
npm install
npm run build
```

Expected: `npm install` completes; `npm run build` exits 0; `dist/` contains `dist/src/index.js`, `dist/bin/cli.js`, etc.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: all files pass Prettier.

- [ ] **Step 4: Tests**

Run: `npm test`
Expected: all unit tests pass, including the new `tool-registration.test.ts`.

- [ ] **Step 5: Verify the CLI binaries work post-build**

```bash
node dist/bin/cli.js --version
```

Expected: `3.0.0`.

```bash
node dist/bin/cli.js --help | head -5
```

Expected: shows the help banner referencing "Claw Orchestrator CLI".

- [ ] **Step 6: Verify both bin names point to the same script**

Run: `node -e "const p=require('./package.json'); const set=new Set(Object.values(p.bin)); console.log(set.size===1 ? 'OK: aliases share one entry point' : 'FAIL: divergent entry points')"`
Expected: `OK: aliases share one entry point`.

- [ ] **Step 7: Final brand-string sweep**

```bash
grep -rn "openclaw-claude-code" src/ bin/ skills/ openclaw.plugin.json README.md CLAUDE.md CONTRIBUTING.md package.json install.sh | grep -v node_modules | grep -v dist | grep -v coverage | grep -v package-lock
```

Expected: only legitimate references remain — specifically:
- `LEGACY_PACKAGE` and `LEGACY_PLUGIN_ID` constants in `install.sh`
- "openclaw-claude-code" in CHANGELOG.md (history)
- "Migrating from `@enderfga/openclaw-claude-code`" section in README.md
- Alias-array literals in `src/index.ts`
- Alias entries in `openclaw.plugin.json` `contracts.tools`

If anything else appears, fix it before tagging.

- [ ] **Step 8: Commit any small fixes from the sweep, if needed**

If Step 7 surfaced stragglers:

```bash
git add <file>
git commit -m "chore(brand): final straggler cleanup"
```

Otherwise nothing to commit.

---

### Task 18: Tag, GitHub release, repo rename, npm deprecate

This is the only task with externally-visible side effects. Execute serially; verify each step before the next.

- [ ] **Step 1: Tag the v3.0.0 release**

```bash
git tag v3.0.0
git log --oneline -1
```

Expected: tag created, latest commit shown.

- [ ] **Step 2: Push commits and tag**

```bash
git push origin main
git push origin v3.0.0
```

Expected: both push successfully. CI (`.github/workflows/ci.yml`) runs and passes on `main`.

- [ ] **Step 3: Rename the GitHub repo**

The user is doing this themselves in the GitHub UI. The CLI equivalent (for the plan's record):

```bash
gh repo rename claw-orchestrator --repo Enderfga/openclaw-claude-code
```

After the rename, GitHub auto-redirects API calls and `git clone` for old URLs, but the canonical URL becomes `https://github.com/Enderfga/claw-orchestrator`.

- [ ] **Step 4: Verify the repo redirect**

```bash
git remote get-url origin
```

If still `git@github.com:Enderfga/openclaw-claude-code.git`, update:

```bash
git remote set-url origin git@github.com:Enderfga/claw-orchestrator.git
git remote -v
```

Expected: shows `claw-orchestrator` repo URL.

- [ ] **Step 5: Verify `install.sh` raw URL works post-rename**

```bash
curl -fsI https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh
```

Expected: HTTP 200 with `content-type: text/plain`. If it 404s, GitHub may not have propagated the rename yet — wait 1–2 minutes and retry.

- [ ] **Step 6: Create the GitHub release**

```bash
gh release create v3.0.0 \
  --title "v3.0.0 — Claw Orchestrator (rebrand)" \
  --notes "$(cat <<'EOF'
**Breaking change release** — see [CHANGELOG.md](./CHANGELOG.md) for full details.

## Summary

- Project renamed from **openclaw-claude-code** to **Claw Orchestrator**.
- npm package: \`@enderfga/openclaw-claude-code\` → \`@enderfga/claw-orchestrator\`
- CLI binary: \`claude-code-skill\` → \`clawo\` (old binary kept as alias through v3.0.x)
- Tool API: 17 \`claude_*\` tools renamed to engine-neutral names. Old names remain as deprecated aliases through v3.0.x; removed in v3.1.

## Migration

```bash
npm uninstall -g @enderfga/openclaw-claude-code
npm install -g @enderfga/claw-orchestrator
# OpenClaw users:
curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
```

See the [Migrating from v2.x](./README.md#migrating-from-enderfgaopenclaw-claude-code-v2x) section for the full guide.
EOF
)"
```

Expected: release published. The `Publish to npm` workflow (`.github/workflows/publish.yml`) auto-triggers and publishes `@enderfga/claw-orchestrator@3.0.0` to npm.

- [ ] **Step 7: Verify CI + publish workflows passed**

```bash
gh run list --limit 4
```

Expected: latest two runs are `CI` (success) and `Publish to npm` (success).

- [ ] **Step 8: Verify the new npm package is live**

```bash
npm view @enderfga/claw-orchestrator version
```

Expected: `3.0.0`.

- [ ] **Step 9: Deprecate the old npm package**

```bash
npm deprecate '@enderfga/openclaw-claude-code@*' \
  'Renamed to @enderfga/claw-orchestrator. See https://github.com/Enderfga/claw-orchestrator for migration guide.'
```

Expected: command succeeds. Future `npm install @enderfga/openclaw-claude-code` users see the deprecation warning.

- [ ] **Step 10: Verify the deprecation message appears**

```bash
npm view @enderfga/openclaw-claude-code deprecated
```

Expected: prints the deprecation string from Step 9.

- [ ] **Step 11: Smoke-test a global install of the new package**

```bash
npm install -g @enderfga/claw-orchestrator
clawo --version
which clawo
which claude-code-skill
```

Expected: `clawo --version` prints `3.0.0`. Both `clawo` and `claude-code-skill` resolve to bin paths under the npm global prefix and (on inspection) point at the same script.

- [ ] **Step 12: Final announcement (optional)**

If you maintain a changelog channel, post the v3.0.0 release link. The plan stops here — the rebrand is shipped.

---

## Self-Review Notes

- **Spec coverage:** Each item in the user's "Confirmed defaults" list (tool rename A, CLI bin alias, new npm package, repo rename, version 3.0.0, plugin id, env var preservation, skill name, banner-legacy, README repositioning) is covered by an explicit task: tool rename → Tasks 10–13; CLI bin → Task 5; npm package → Tasks 2 + 18.9; repo rename → Task 18.3; version 3.0.0 → Task 2 + 15; plugin id → Tasks 3 + 14; env vars → mentioned-as-unchanged in Tasks 7 + 15; skill name → Task 6; banner-legacy → Task 1; README repositioning → Task 8.
- **Mechanical-vs-API split:** Part A (Tasks 1–9) is pure rename; Part B (Tasks 10–13) is the only part that changes runtime behavior of the public API and is the only part that requires careful review; Part C (Tasks 14–18) is release plumbing.
- **No placeholders:** Every step shows exact code or exact commands. The full new contents of `package.json`, `README.md`, `CHANGELOG.md`'s v3.0.0 entry, and the new `tool-registration.test.ts` are inlined.
- **Alias mechanism is testable:** Task 12 adds a 4-case unit test that runs the plugin's `register` against a stub PluginAPI, capturing every `registerTool` call. Future accidental removal of either canonical name or alias breaks the test.
- **Reversibility:** Every commit on Parts A and B is a normal commit on `main` (or a feature branch); reverting a single task is `git revert <sha>`. Part C is the only externally-visible step and is back-stop-able only by un-deprecating the old npm package and renaming the GitHub repo back, both of which are user-driven UI actions.

---
