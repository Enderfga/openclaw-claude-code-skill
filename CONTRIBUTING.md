# Contributing to Claw Orchestrator

## Dev Environment Setup

```bash
git clone https://github.com/Enderfga/claw-orchestrator.git
cd claw-orchestrator
npm install
npm run build
```

**Prerequisite:** Claude Code CLI must be installed for integration testing:

```bash
npm install -g @anthropic-ai/claude-code
```

## Running Tests

```bash
# Type-check and build
npm run build

# Integration tests (requires Claude Code CLI)
npx tsx test-integration.ts
```

## Code Style

- TypeScript with full types — no `any`
- ESM modules (`"type": "module"`)
- Follow existing patterns in `src/`
- No formatting changes to files you didn't modify

## PR Guidelines

- **One feature or fix per PR**
- Use a descriptive title: `feat:`, `fix:`, `docs:`, `chore:`
- Include a clear description of what changed and why
- Run `npm run build` before submitting — PRs that don't build won't be reviewed
- Update `CHANGELOG.md` for user-facing changes

## Issue Guidelines

- Search existing issues before opening a new one
- Use the provided templates (bug report / feature request)
- Include OpenClaw version, Node.js version, and plugin version
- Redact any sensitive info from logs
