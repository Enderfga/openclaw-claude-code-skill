/**
 * MCP Utility Functions
 */

/**
 * Check if content contains MCP JSON format
 */
export function isMcpJson(content: string) {
  return content.match(/```json:mcp:([^{\s]+)([\s\S]*?)```/);
}

/**
 * Extract MCP JSON from content
 */
export function extractMcpJson(content: string) {
  const match = content.match(/```json:mcp:([^{\s]+)([\s\S]*?)```/);
  if (match && match.length === 3) {
    return { clientId: match[1], mcp: JSON.parse(match[2]) };
  }
  return null;
}
