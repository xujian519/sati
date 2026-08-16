/**
 * `McpClient` — single-server façade around `@modelcontextprotocol/sdk`'s
 * `Client`. Implements behaviours M1, M2, M3, M5, M6, M14, M15, M16 from
 * the §6.1 contract.
 *
 * - M1 connect() is memoized internally (calling `start` twice yields the
 *   same connection).
 * - M2 transports: `stdio` + `streamable_http` (SSE / WebSocket are
 *   intentionally unsupported in this PR; D-tier).
 * - M3 wraps `callTool` / `listTools` with a configurable timeout
 *   (default 60s; cf. legacy 27.8h — see `intentional_difference`).
 * - M5 / M15 detects `mcp_session_expired` and triggers exactly one
 *   reconnect attempt for the next call.
 * - M5b on `-32001 Request timed out` we recycle the underlying transport
 *   (close + drop refs) before re-throwing, so the *next* `callTool` /
 *   `listTools` spawns a fresh subprocess. Stdio MCP servers like
 *   `@playwright/mcp` can keep an in-flight request pending server-side
 *   after a client timeout (e.g. `page.goto` stuck on a dead TCP
 *   connection), which wedges every follow-up call from the same session.
 * - M6 LRU-caches the result of `listTools()` for `LRU_TTL_MS` (5 min).
 *   Cache is invalidated on reconnect.
 *
 * Errors raised by `callTool` / `listTools` always carry one of the
 * Sati-style `mcp_*` error codes via the `code` field on the thrown
 * error, so the caller can map them back to `SatiToolErrorCode`.
 *
 * 拆分注记（A8/A9）：连接状态机 → ./connection.ts；RPC 包装 →
 * ./operations.ts；本文件为组合门面（spec/options + 委托），
 * `McpClientOptions` 与 re-export 保持 barrel 面不变。
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SatiMcpResource, SatiMcpServerSpec, SatiMcpStatus, SatiMcpToolSpec } from "../protocol/types.js";
import { McpConnection } from "./connection.js";
import { McpClientOperations } from "./operations.js";

// 门面再导出（定义见 ./errors.js，保持 "./client/McpClient.js" 导出面不变）
export { McpClientError } from "./errors.js";

export type McpClientOptions = {
  callTimeoutMs?: number;
  /** Connect handshake timeout. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Optional override for testing — supply a pre-built Transport instance. */
  transportFactory?: (spec: SatiMcpServerSpec) => Transport;
  /** Optional fetch override for testing streamable HTTP transports. */
  fetch?: typeof fetch;
};

export class McpClient {
  private readonly connection: McpConnection;
  private readonly operations: McpClientOperations;

  constructor(
    public readonly spec: SatiMcpServerSpec,
    private readonly options: McpClientOptions = {},
  ) {
    this.connection = new McpConnection(spec, options);
    this.operations = new McpClientOperations(spec, options, this.connection);
  }

  getStatus(): SatiMcpStatus {
    return this.connection.getStatus();
  }

  getInstructions(): string {
    return this.connection.getInstructions();
  }

  /** M1 — memoized connect（委托连接状态机）。 */
  async start(): Promise<void> {
    await this.connection.start();
  }

  /** M6 — LRU-cached tools/list. */
  listTools(): Promise<SatiMcpToolSpec[]> {
    return this.operations.listTools();
  }

  /** M3 + M5 + M14 + M15 — call a tool with timeout + auto-reconnect once. */
  callTool(
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ content: unknown; isError?: boolean }> {
    return this.operations.callTool(toolName, args, options);
  }

  /** List resources advertised by this server (MCP resources capability). */
  listResources(): Promise<{ resources: SatiMcpResource[] }> {
    return this.operations.listResources();
  }

  /** Read a resource by URI (MCP resources capability). */
  readResource(uri: string): Promise<{ contents: unknown }> {
    return this.operations.readResource(uri);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
