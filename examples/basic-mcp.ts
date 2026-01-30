/**
 * Basic MCP Setup Example
 *
 * This example shows how to initialize and use MCP servers
 * with the openclaw-claude-code-skill package.
 */

import {
  initializeMcpSystem,
  addMcpServer,
  executeMcpAction,
  getAllTools,
  getClientsStatus,
  setConfigPath,
} from "../src";

async function main() {
  // Optional: Set a custom config path
  setConfigPath("./mcp_config.json");

  // Initialize the MCP system
  console.log("Initializing MCP system...");
  await initializeMcpSystem();

  // Add a filesystem server
  console.log("Adding filesystem server...");
  await addMcpServer("filesystem", {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "./"],
  });

  // Wait for initialization
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check status
  const status = await getClientsStatus();
  console.log("Server status:", status);

  // Get all available tools
  const tools = await getAllTools();
  console.log("Available tools:", JSON.stringify(tools, null, 2));

  // Execute a tool call (list directory)
  try {
    const result = await executeMcpAction("filesystem", {
      method: "tools/call",
      params: {
        name: "list_directory",
        arguments: { path: "./" },
      },
    });
    console.log("Directory listing:", result);
  } catch (error) {
    console.error("Error executing tool:", error);
  }
}

main().catch(console.error);
