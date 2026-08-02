/**
 * Gateway-side MCP tool registration helpers.
 *
 * `ensureMcpReady` in `createLocalGateway.ts` owns the lifecycle of the
 * project-level `McpRuntime`; this module owns the bookkeeping of which
 * Sati tools to surface alongside it — the per-server tool definitions and
 * the MCP resources / status tools — so the gateway file stays focused on
 * orchestration rather than registry plumbing.
 */

import type { SatiToolDefinition, ToolRegistry } from "../tool/index.js";
import {
  createListMcpResourcesTool,
  createMcpStatusTool,
  createReadMcpResourceTool,
  type SatiMcpResourceAdapter,
  type SatiMcpStatusAdapter,
} from "../tool/index.js";
import type { McpRuntime } from "../mcp/index.js";

/** Register each definition unless an identically-named tool already exists. */
export function registerToolsIfAbsent(tools: ToolRegistry, defs: SatiToolDefinition[]): void {
  for (const def of defs) {
    if (!tools.has(def.name)) tools.register(def);
  }
}

/**
 * Register the MCP resources + status tools backed by a project-level shared
 * `McpRuntime`. Per-session runtimes are session-scoped and therefore not
 * reflected here.
 */
export function registerMcpAuxTools(tools: ToolRegistry, runtime: McpRuntime): void {
  const resourceAdapter: SatiMcpResourceAdapter = {
    listResources: serverId => runtime.listResources(serverId),
    readResource: (serverId, uri) => runtime.readResource(serverId, uri),
  };
  const statusAdapter: SatiMcpStatusAdapter = {
    statuses: () => runtime.statuses(),
  };
  registerToolsIfAbsent(tools, [
    createListMcpResourcesTool(resourceAdapter),
    createReadMcpResourceTool(resourceAdapter),
    createMcpStatusTool(statusAdapter),
  ]);
}
