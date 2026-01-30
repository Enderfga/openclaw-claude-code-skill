# OpenClaw Claude Code Skill

A skill package for [OpenClaw](https://github.com/openclaw/openclaw) / Claude Code that enables:

- **MCP (Model Context Protocol)** integration for sub-agent orchestration
- **State persistence** and context recovery across sessions
- **Session synchronization** for multi-device support

## Features

### 🔌 MCP Integration

Full implementation of the [Model Context Protocol](https://spec.modelcontextprotocol.io/) for managing AI tool servers:

- Create and manage MCP client connections
- Execute tool calls across multiple servers
- Server lifecycle management (pause/resume/restart)

### 💾 State Persistence

Robust state management with automatic recovery:

- IndexedDB storage with localStorage fallback
- Hydration tracking to prevent data loss
- Timestamp-based merge conflict resolution

### 🔄 Session Sync

Smart synchronization utilities:

- Merge sessions from multiple sources
- Preserve message history across devices
- Key-value store merging

## Installation

```bash
npm install openclaw-claude-code-skill
# or
yarn add openclaw-claude-code-skill
```

## Quick Start

### MCP Server Management

```typescript
import {
  initializeMcpSystem,
  addMcpServer,
  executeMcpAction,
  getAllTools,
} from "openclaw-claude-code-skill";

// Initialize the MCP system
await initializeMcpSystem();

// Add a new MCP server
await addMcpServer("my-server", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
});

// Get all available tools
const tools = await getAllTools();
console.log(tools);

// Execute a tool call
const result = await executeMcpAction("my-server", {
  method: "tools/call",
  params: {
    name: "read_file",
    arguments: { path: "/path/to/file.txt" },
  },
});
```

### State Persistence

```typescript
import { createPersistStore, indexedDBStorage } from "openclaw-claude-code-skill";

// Create a persistent store
const useMyStore = createPersistStore(
  // Initial state
  { count: 0, items: [] },
  // Methods
  (set, get) => ({
    increment: () => set({ count: get().count + 1 }),
    addItem: (item: string) => set({ items: [...get().items, item] }),
  }),
  // Persist options
  { name: "my-store" },
  // Optional: use IndexedDB
  indexedDBStorage
);

// Use in your app
const { count, increment, _hasHydrated } = useMyStore();

// Check if state has been restored
if (_hasHydrated) {
  console.log("State restored from storage!");
}
```

### Session Synchronization

```typescript
import { mergeSessions, mergeWithUpdate } from "openclaw-claude-code-skill";

// Merge chat sessions from multiple sources
const mergedSessions = mergeSessions(localSessions, remoteSessions);

// Merge configs with timestamp-based resolution
const mergedConfig = mergeWithUpdate(localConfig, remoteConfig);
```

## MCP Configuration

Create a `mcp_config.json` file:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "status": "active"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "your-token-here"
      },
      "status": "active"
    }
  }
}
```

Set a custom config path:

```typescript
import { setConfigPath } from "openclaw-claude-code-skill";

setConfigPath("/path/to/your/mcp_config.json");
```

## API Reference

### MCP Module

| Function | Description |
|----------|-------------|
| `initializeMcpSystem()` | Initialize all configured MCP servers |
| `addMcpServer(id, config)` | Add a new MCP server |
| `removeMcpServer(id)` | Remove an MCP server |
| `pauseMcpServer(id)` | Pause an MCP server |
| `resumeMcpServer(id)` | Resume a paused server |
| `executeMcpAction(id, request)` | Execute a tool call |
| `getAllTools()` | Get all available tools |
| `getClientsStatus()` | Get status of all clients |
| `setConfigPath(path)` | Set custom config file path |

### Store Module

| Function | Description |
|----------|-------------|
| `createPersistStore(state, methods, options, storage?)` | Create a persistent Zustand store |
| `indexedDBStorage` | IndexedDB storage adapter |
| `mergeSessions(local, remote)` | Merge session arrays |
| `mergeWithUpdate(local, remote)` | Merge with timestamp resolution |
| `mergeKeyValueStore(local, remote)` | Merge key-value stores |

## Types

```typescript
interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  status?: "active" | "paused" | "error";
}

interface McpRequestMessage {
  jsonrpc?: "2.0";
  id?: string | number;
  method: "tools/call" | string;
  params?: Record<string, unknown>;
}

type ServerStatus = "undefined" | "active" | "paused" | "error" | "initializing";
```

## Examples

See the [examples](./examples) directory for complete usage examples:

- [Basic MCP Setup](./examples/basic-mcp.ts)
- [Persistent Chat Store](./examples/chat-store.ts)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](./LICENSE) for details.

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) - The AI assistant platform
- [Model Context Protocol](https://github.com/modelcontextprotocol) - The protocol specification
- [Zustand](https://github.com/pmndrs/zustand) - State management library
