import type { PermissionResult } from "../../permission/index.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import type { PolitDeckToolDefinition, PolitDeckToolExecutionOutput } from "../protocol/types.js";
import type { PolitDeckToolInputSchema } from "../protocol/schema.js";

export type PolitDeckMcpToolAdapter = {
  callTool(serverId: string, toolName: string, input: unknown): Promise<unknown>;
};

export type CreateMcpToolOptions = {
  serverId: string;
  toolName: string;
  description?: string;
  inputSchema?: PolitDeckToolInputSchema;
  adapter?: PolitDeckMcpToolAdapter;
};

export function createMcpTool(options: CreateMcpToolOptions): PolitDeckToolDefinition {
  const wireName = buildMcpToolWireName(options.serverId, options.toolName);
  return {
    name: wireName,
    description: options.description ?? `Call MCP tool ${options.serverId}/${options.toolName}.`,
    kind: "mcp",
    inputSchema: options.inputSchema ?? { type: "object", additionalProperties: true, properties: {} },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({ type: "passthrough" }),
    execute: async (input): Promise<PolitDeckToolExecutionOutput> => {
      if (!options.adapter) {
        throw new PolitDeckToolRuntimeError("unsupported_tool", "MCP adapter is not configured.");
      }
      const value = await options.adapter.callTool(options.serverId, options.toolName, input);
      return {
        content: [{ type: "json", value }],
        data: value,
        metadata: {
          mcp: {
            serverId: options.serverId,
            toolName: options.toolName,
            wireName,
          },
        },
      };
    },
  };
}

export function buildMcpToolWireName(serverId: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverId)}__${normalizeMcpName(toolName)}`;
}

function normalizeMcpName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!normalized) {
    throw new PolitDeckToolRuntimeError("invalid_tool_input", "MCP server and tool names must normalize to a name.");
  }
  return normalized;
}
