/**
 * Gemini Tool Schema Cleaner
 *
 * Gemini doesn't support certain JSON Schema fields that Anthropic tools use.
 * This recursively cleans schemas for compatibility.
 */

const UNSUPPORTED_KEYS = new Set(['additionalProperties', 'default', '$schema']);
const ALLOWED_STRING_FORMATS = new Set(['enum', 'date-time']);

/**
 * Recursively clean a JSON Schema for Gemini compatibility.
 * Removes unsupported fields and string formats.
 */
export function cleanGeminiSchema(schema: unknown): unknown {
  if (schema === null || schema === undefined || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanGeminiSchema);

  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip unsupported keys
    if (UNSUPPORTED_KEYS.has(key)) continue;

    // Clean string format restrictions
    if (key === 'format' && obj.type === 'string') {
      if (typeof value === 'string' && !ALLOWED_STRING_FORMATS.has(value)) continue;
    }

    // Recurse into nested objects/arrays
    cleaned[key] = cleanGeminiSchema(value);
  }

  return cleaned;
}
