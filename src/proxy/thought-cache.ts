/**
 * Thought Signature Cache — Gemini round-trip support
 *
 * Gemini 2.5+ with thinking requires `thought_signature` in tool_calls
 * for 2nd+ turns. We cache signatures from responses and inject on next request.
 *
 * Uses in-memory LRU cache (no file I/O needed in plugin context).
 */

const MAX_CACHE_SIZE = 100;
const cache = new Map<string, string>();

/** Cache a thought signature from a tool call response */
export function cacheThoughtSig(toolCallId: string, signature: string): void {
  if (!toolCallId || !signature) return;

  // Evict oldest if over limit
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(toolCallId, signature);
}

/** Get a cached thought signature for a tool call */
export function getThoughtSig(toolCallId: string): string {
  return cache.get(toolCallId) || '';
}

/**
 * Inject cached thought signatures into messages for Gemini round-trip.
 * Mutates the messages array in place.
 */
export function injectThoughtSigs(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!toolCalls) continue;

    for (const tc of toolCalls) {
      const id = tc.id as string;
      if (!id) continue;
      const sig = getThoughtSig(id);
      if (sig) {
        tc.extra_content = { google: { thought_signature: sig } };
      }
    }
  }
}

/** Clear the cache (for testing) */
export function clearCache(): void {
  cache.clear();
}
