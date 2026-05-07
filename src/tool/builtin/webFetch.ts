import type { PermissionResult } from "../../permission/index.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import type { PolitDeckToolDefinition } from "../protocol/types.js";

export type WebFetchInput = {
  url: string;
};

export function createWebFetchTool(): PolitDeckToolDefinition<WebFetchInput> {
  return {
    name: "web_fetch",
    aliases: ["WebFetch"],
    description: "Fetch text content from a web URL.",
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        url: { type: "string" },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_fetch", message: "Network access requires permission." },
      request: {
        toolCallId: "",
        toolName: "web_fetch",
        inputSummary: "network fetch",
        reason: { type: "tool", toolName: "web_fetch", message: "Network access requires permission." },
        options: [
          { id: "allow_once", label: "Allow fetch" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async () => {
      throw new PolitDeckToolRuntimeError("unsupported_tool", "web_fetch provider is not configured.");
    },
  };
}
