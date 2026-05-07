import type { PermissionResult } from "../../permission/index.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import type { PolitDeckToolDefinition } from "../protocol/types.js";

export type WebSearchInput = {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

export function createWebSearchTool(): PolitDeckToolDefinition<WebSearchInput> {
  return {
    name: "web_search",
    aliases: ["WebSearch"],
    description: "Search the web through a configured provider.",
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        allowedDomains: { type: "array", items: { type: "string" } },
        blockedDomains: { type: "array", items: { type: "string" } },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "web search",
        reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async () => {
      throw new PolitDeckToolRuntimeError("unsupported_tool", "web_search provider is not configured.");
    },
  };
}
