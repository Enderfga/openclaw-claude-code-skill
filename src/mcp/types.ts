/**
 * MCP (Model Context Protocol) Type Definitions
 * Reference: https://spec.modelcontextprotocol.io/specification/basic/messages/
 */

import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// MCP Request Message
export interface McpRequestMessage {
  jsonrpc?: "2.0";
  id?: string | number;
  method: "tools/call" | string;
  params?: {
    [key: string]: unknown;
  };
}

export const McpRequestMessageSchema: z.ZodType<McpRequestMessage> = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

// MCP Response Message
export interface McpResponseMessage {
  jsonrpc?: "2.0";
  id?: string | number;
  result?: {
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const McpResponseMessageSchema: z.ZodType<McpResponseMessage> = z.object(
  {
    jsonrpc: z.literal("2.0").optional(),
    id: z.union([z.string(), z.number()]).optional(),
    result: z.record(z.unknown()).optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  },
);

// MCP Notifications
export interface McpNotifications {
  jsonrpc?: "2.0";
  method: string;
  params?: {
    [key: string]: unknown;
  };
}

export const McpNotificationsSchema: z.ZodType<McpNotifications> = z.object({
  jsonrpc: z.literal("2.0").optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

// List Tools Response
export interface ListToolsResponse {
  tools: {
    name?: string;
    description?: string;
    inputSchema?: object;
    [key: string]: any;
  };
}

// MCP Client Data States
export type McpClientData =
  | McpActiveClient
  | McpErrorClient
  | McpInitializingClient;

interface McpInitializingClient {
  client: null;
  tools: null;
  errorMsg: null;
}

interface McpActiveClient {
  client: Client;
  tools: ListToolsResponse;
  errorMsg: null;
}

interface McpErrorClient {
  client: null;
  tools: null;
  errorMsg: string;
}

// Server Status Types
export type ServerStatus =
  | "undefined"
  | "active"
  | "paused"
  | "error"
  | "initializing";

export interface ServerStatusResponse {
  status: ServerStatus;
  errorMsg: string | null;
}

// MCP Server Configuration
export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  status?: "active" | "paused" | "error";
}

export interface McpConfigData {
  mcpServers: Record<string, ServerConfig>;
}

export const DEFAULT_MCP_CONFIG: McpConfigData = {
  mcpServers: {},
};

// Arguments Mapping for Preset Servers
export interface ArgsMapping {
  type: "spread" | "single" | "env";
  position?: number;
  key?: string;
}

// Preset Server Configuration
export interface PresetServer {
  id: string;
  name: string;
  description: string;
  repo: string;
  tags: string[];
  command: string;
  baseArgs: string[];
  configurable: boolean;
  configSchema?: {
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        required?: boolean;
        minItems?: number;
      }
    >;
  };
  argsMapping?: Record<string, ArgsMapping>;
}
