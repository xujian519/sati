/**
 * `PluginToToolBridge` — converts the runtime view of MCP tools (advertised
 * by an `McpRuntime`) into PolitDeck `ToolDefinition`s suitable for
 * registration in `ToolRegistry`. Implements M10-M12 of §6.1:
 *
 *   - M10  wire name `mcp__<serverId>__<toolName>` (already produced by
 *          `McpClient.listTools`).
 *   - M11  description ≤ 2048 chars (already truncated).
 *   - M12  annotations.readOnlyHint / destructiveHint / openWorldHint
 *          reflected onto the PolitDeck tool flags so the permission
 *          engine can decide whether to ask.
 *
 * Result transformation (M14): we currently emit a single `json` result
 * block. The existing `ToolRuntime` already truncates oversized payloads
 * via `maxResultBytes`; deferring the persisted-large-blob path for now
 * (recorded as `intentional_difference` in the parity table).
 */

import { PolitDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type {
  PolitDeckToolDefinition,
  PolitDeckToolExecutionOutput,
  PolitDeckToolInputSchema,
} from "../../tool/index.js";
import type { McpClient } from "../client/McpClient.js";
import type { McpRuntime } from "./McpRuntime.js";
import type {
  PolitDeckMcpToolAnnotations,
  PolitDeckMcpToolSpec,
} from "../protocol/types.js";

export type CreateToolDefinitionsOptions = {
  /** Per-call timeout override (default falls through to McpClient default). */
  callTimeoutMs?: number;
};

export async function createMcpToolDefinitionsFromRuntime(
  runtime: McpRuntime,
  options: CreateToolDefinitionsOptions = {},
): Promise<PolitDeckToolDefinition[]> {
  const tools = await runtime.listAllTools();
  return tools.map((spec) => buildToolDefinition(spec, runtime, options));
}

function buildToolDefinition(
  spec: PolitDeckMcpToolSpec,
  runtime: McpRuntime,
  options: CreateToolDefinitionsOptions,
): PolitDeckToolDefinition {
  const annotations: PolitDeckMcpToolAnnotations = spec.annotations ?? {};
  const isReadOnly = annotations.readOnlyHint === true;
  const isDestructive = annotations.destructiveHint === true;
  const isOpenWorld = annotations.openWorldHint !== false;

  const inputSchema = normalizeSchema(spec.inputSchema);

  return {
    name: spec.wireName,
    description: spec.description,
    kind: "mcp",
    inputSchema,
    maxResultBytes: 200_000,
    isReadOnly: () => isReadOnly,
    isConcurrencySafe: () => isReadOnly,
    isDestructive: () => isDestructive,
    isOpenWorld: () => isOpenWorld,
    execute: async (input, context): Promise<PolitDeckToolExecutionOutput> => {
      const client: McpClient | undefined = runtime.getClient(spec.serverId);
      if (!client) {
        throw new PolitDeckToolRuntimeError(
          "unsupported_tool",
          `MCP server ${spec.serverId} is not registered`,
        );
      }
      try {
        const { content, isError } = await client.callTool(spec.toolName, input, {
          signal: context.abortSignal,
          timeoutMs: options.callTimeoutMs,
        });
        if (isError === true) {
          throw new PolitDeckToolRuntimeError(
            "tool_execution_failed",
            `MCP server ${spec.serverId}/${spec.toolName} returned isError`,
            { content },
          );
        }
        return {
          content: [{ type: "json", value: content }],
          data: content,
          metadata: {
            mcp: { serverId: spec.serverId, toolName: spec.toolName, wireName: spec.wireName },
          },
        };
      } catch (err) {
        if (err instanceof PolitDeckToolRuntimeError) throw err;
        const e = err as { code?: string; message?: string };
        if (e.code === "mcp_call_timeout") {
          throw new PolitDeckToolRuntimeError(
            "tool_execution_failed",
            e.message ?? `MCP call timed out (${spec.serverId}/${spec.toolName})`,
            { errorCode: "mcp_call_timeout" },
          );
        }
        if (e.code === "mcp_session_expired") {
          throw new PolitDeckToolRuntimeError(
            "tool_execution_failed",
            e.message ?? `MCP session expired (${spec.serverId}/${spec.toolName})`,
            { errorCode: "mcp_session_expired" },
          );
        }
        throw new PolitDeckToolRuntimeError(
          "tool_execution_failed",
          e.message ?? `MCP call failed (${spec.serverId}/${spec.toolName})`,
          { errorCode: e.code ?? "mcp_call_failed" },
        );
      }
    },
  };
}

function normalizeSchema(raw: unknown): PolitDeckToolInputSchema {
  if (raw && typeof raw === "object") {
    const obj = raw as PolitDeckToolInputSchema;
    if (obj.type === "object") return obj;
  }
  return { type: "object", additionalProperties: true, properties: {} };
}
