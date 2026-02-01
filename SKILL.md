# OpenClaw Claude Code Skill

## Description

MCP (Model Context Protocol) integration for OpenClaw/Clawdbot. Use when you need to:
- Connect and orchestrate MCP tool servers (filesystem, GitHub, etc.)
- Persist state across sessions with IndexedDB/localStorage
- Sync sessions across multiple devices

Triggers: "MCP", "tool server", "sub-agent orchestration", "session sync", "state persistence", "Claude Code integration"

## Installation

```bash
npm install openclaw-claude-code-skill
```

## Core APIs

### MCP Server Management

```typescript
import { 
  initializeMcpSystem, 
  addMcpServer, 
  executeMcpAction, 
  getAllTools 
} from "openclaw-claude-code-skill";

// 1. Initialize all configured servers
await initializeMcpSystem();

// 2. Add a new MCP server
await addMcpServer("fs", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
});

// 3. Get available tools
const tools = await getAllTools();

// 4. Call a tool
const result = await executeMcpAction("fs", {
  method: "tools/call",
  params: { name: "read_file", arguments: { path: "/tmp/test.txt" } }
});
```

### State Persistence

```typescript
import { createPersistStore, indexedDBStorage } from "openclaw-claude-code-skill";

const useStore = createPersistStore(
  { count: 0, items: [] },
  (set, get) => ({
    increment: () => set({ count: get().count + 1 }),
    addItem: (item: string) => set({ items: [...get().items, item] })
  }),
  { name: "my-store" },
  indexedDBStorage  // or omit for localStorage
);

// Check hydration status
if (useStore.getState()._hasHydrated) {
  console.log("State restored!");
}
```

### Session Synchronization

```typescript
import { mergeSessions, mergeWithUpdate, mergeKeyValueStore } from "openclaw-claude-code-skill";

// Merge chat sessions from multiple sources
const mergedSessions = mergeSessions(localSessions, remoteSessions);

// Merge configs with timestamp-based resolution
const mergedConfig = mergeWithUpdate(localConfig, remoteConfig);
```

## Key Functions

| Function | Purpose |
|----------|---------|
| `initializeMcpSystem()` | Start all MCP servers from config |
| `addMcpServer(id, config)` | Add new server dynamically |
| `removeMcpServer(id)` | Remove a server |
| `pauseMcpServer(id)` | Pause a server |
| `resumeMcpServer(id)` | Resume a paused server |
| `executeMcpAction(id, req)` | Call a tool on specific server |
| `getAllTools()` | List all available tools |
| `getClientsStatus()` | Get status of all MCP clients |
| `setConfigPath(path)` | Set custom config file location |
| `createPersistStore()` | Create Zustand store with persistence |
| `mergeSessions()` | Merge session arrays |
| `mergeWithUpdate()` | Merge with timestamp resolution |
| `mergeKeyValueStore()` | Merge key-value stores |

## Configuration

Create `mcp_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "status": "active"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "your-token" },
      "status": "active"
    }
  }
}
```

Set custom config path:

```typescript
import { setConfigPath } from "openclaw-claude-code-skill";
setConfigPath("/path/to/mcp_config.json");
```

## Requirements

- Node.js 18+
- TypeScript (optional but recommended)

## Links

- [GitHub](https://github.com/Enderfga/openclaw-claude-code-skill)
- [npm](https://www.npmjs.com/package/openclaw-claude-code-skill)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
