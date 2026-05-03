# Code Review: 2026-05-03

Reviewed by graphify knowledge graph analysis + manual inspection.

## Summary

The codebase is well-engineered with solid patterns. All identified issues from the review are already handled correctly in the current code.

## Architecture Assessment

| Component | Status | Notes |
|-----------|--------|-------|
| SessionManager | ✅ Solid | Central hub, clean abstraction, no HTTP dep |
| PersistentClaudeSession | ✅ Solid | CLI wrapper with proper streaming |
| CircuitBreaker | ✅ Solid | Exponential backoff, proper reset on success |
| Consensus | ✅ Solid | Multiple fallback patterns, removed tail-fallback to avoid false positives |
| OpenAI Compatibility | ✅ Solid | Bridges web frontends correctly |
| EmbeddedServer | ✅ Solid | Rate limiting, TTL cleanup, proper shutdown |
| Council | ✅ Solid | Multi-agent with git worktree isolation |
| Model Registry | ✅ Solid | Single source of truth pattern |

## Verified Fixes

The following issues from initial review are already handled:

- **Rate limit map TTL pruning**: `_rateWindows.delete(ip)` when empty
- **clearInterval in stop()**: `clearInterval(_rateLimitCleanupTimer)` in `stop()`
- **History eviction**: `shift()` when `length > MAX_HISTORY_ITEMS`
- **Async rename error handling**: `fs.unlink(tmp)` on rename failure
- **stopSession cleanup**: Deletes from sessions, PIDs, and persistedSessions maps
- **Atomic persistence writes**: `.tmp + renameSync` pattern prevents corruption

## Design Patterns (Good Examples)

1. **Atomic writes** (`session-manager.ts`): Write to `.tmp` then `renameSync` — crash-resistant
2. **Constants consolidation** (`constants.ts`): All magic numbers centralized
3. **ISession interface**: Enables multi-engine abstraction cleanly
4. **TTL-based cleanup** (`embedded-server.ts`): Rate limit map auto-prunes stale entries
5. **History cap with eviction**: `MAX_HISTORY_ITEMS` + `shift()` prevents unbounded growth

## Minor Observations (Not Bugs)

These are documented for awareness, not action required:

1. **Circuit breaker count never decays**: Intentional — resets on success. Consider a max count cap if engines fail repeatedly over long periods (e.g., 10 failures before manual intervention).

2. **Consensus fallback removed**: Deliberate decision to avoid false positives. The parser returns `false` for no consensus, which rejects the task. Consider adding a `parseConsensusWithAmbiguity()` variant that returns `null` for ambiguous cases.

3. **GPT-5.4 model entries**: These look planned for future release. Verify when models are officially announced.

4. **`getPluginVersion()` silent fail**: Error swallowed with `/* ignore */`. Consider debug-level logging in future.

5. **Hardcoded 127.0.0.1**: Intentional security default. No change needed.

## Recommendations

For future improvements (not required):

1. Add `MAX_BREAKER_COUNT` constant to cap circuit breaker failures
2. Add `parseConsensusWithAmbiguity()` returning `true | false | null` for ambiguous cases
3. Consider adding `MAX_HISTORY_AGE_MS` for time-based eviction in addition to count-based

## Test Coverage

Current test files:
- `src/__tests__/session-manager.test.ts`
- `src/__tests__/circuit-breaker.test.ts`
- `src/__tests__/models.test.ts`
- `src/__tests__/council-postprocess.test.ts`
- `test-integration.ts` (manual, requires live CLIs)

Consider adding tests for:
- Race conditions in `savePersistedSessionsAsync`
- Circuit breaker behavior with rapid success/failure cycles
- Consensus parser with malformed input strings