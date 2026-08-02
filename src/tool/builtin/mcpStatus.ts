import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import type { SatiMcpClientStatusEntry } from "../../mcp/protocol/types.js";

export type SatiMcpStatusAdapter = {
  statuses(): SatiMcpClientStatusEntry[];
};

/**
 * `mcp_status` — read-only tool that surfaces the connection state of every
 * configured MCP server so the agent (and the user) can see which servers
 * are ready, connecting, or failed without reading gateway logs.
 */
export function createMcpStatusTool(adapter?: SatiMcpStatusAdapter): SatiToolDefinition {
  return {
    name: "mcp_status",
    aliases: ["McpStatusTool"],
    description: "List configured MCP servers and their connection status (ready/connecting/error).",
    kind: "mcp",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async () => {
      if (!adapter) {
        throw new SatiToolRuntimeError("unsupported_tool", "MCP status adapter is not configured.");
      }
      const value = adapter.statuses();
      return { content: [{ type: "json", value }], data: value };
    },
  };
}
