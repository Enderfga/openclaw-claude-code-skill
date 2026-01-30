/**
 * OpenClaw Claude Code Skill
 *
 * A skill package that enables:
 * - MCP (Model Context Protocol) integration for sub-agent orchestration
 * - State persistence and context recovery
 * - Session management and synchronization
 */

export * from "./mcp";
export * from "./store";

// Re-export commonly used types
export type {
  McpRequestMessage,
  McpResponseMessage,
  ServerConfig,
  McpConfigData,
  ServerStatus,
  ServerStatusResponse,
  PresetServer,
} from "./mcp/types";

// Re-export commonly used functions
export {
  initializeMcpSystem,
  addMcpServer,
  removeMcpServer,
  pauseMcpServer,
  resumeMcpServer,
  executeMcpAction,
  getAllTools,
  getClientsStatus,
  setConfigPath,
} from "./mcp/actions";

export {
  createPersistStore,
} from "./store/persist";

export {
  indexedDBStorage,
} from "./store/indexeddb-storage";

export {
  mergeSessions,
  mergeWithUpdate,
  mergeKeyValueStore,
} from "./store/sync";
