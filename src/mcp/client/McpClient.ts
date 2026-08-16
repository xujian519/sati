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
 * 拆分注记（A8 轮次 2）：连接状态机已迁至 ./connection.ts（8 字段 +
 * start/runConnect/callWithReconnect/reconnect/recycle/close），本文件为
 * 组合门面：spec/options + 连接委托 + RPC 包装（listTools/callTool/
 * listResources/readResource）。
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { recursivelySanitizeUnicode } from "../runtime/sanitize.js";
import type { SatiMcpResource, SatiMcpServerSpec, SatiMcpStatus, SatiMcpToolSpec } from "../protocol/types.js";
import { toToolSpec } from "./toolSpec.js";
import { DEFAULT_CALL_TIMEOUT_MS } from "./transport.js";
import { McpConnection } from "./connection.js";

// 门面再导出（定义见 ./errors.js，保持 "./client/McpClient.js" 导出面不变）
export { McpClientError } from "./errors.js";

const LIST_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;

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

  constructor(
    public readonly spec: SatiMcpServerSpec,
    private readonly options: McpClientOptions = {},
  ) {
    this.connection = new McpConnection(spec, options);
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
  async listTools(): Promise<SatiMcpToolSpec[]> {
    const cached = this.connection.getToolsCache();
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    const sdkResult = await this.connection.callWithReconnect(client =>
      client.listTools(undefined, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );

    const tools = (sdkResult.tools ?? []).map((tool: unknown) => toToolSpec(tool, this.spec.id));
    this.connection.setToolsCache({
      tools,
      expiresAt: Date.now() + LIST_TOOLS_CACHE_TTL_MS,
    });
    return tools;
  }

  /** M3 + M5 + M14 + M15 — call a tool with timeout + auto-reconnect once. */
  async callTool(
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ content: unknown; isError?: boolean }> {
    const timeoutMs = options.timeoutMs ?? this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const result = await this.connection.callWithReconnect(client =>
      client.callTool({ name: toolName, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
        timeout: timeoutMs,
        signal: options.signal,
      }),
    );
    return {
      content: recursivelySanitizeUnicode(result.content),
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
    };
  }

  /** List resources advertised by this server (MCP resources capability). */
  async listResources(): Promise<{ resources: SatiMcpResource[] }> {
    const result = await this.connection.callWithReconnect(client =>
      client.listResources(undefined, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );
    return { resources: recursivelySanitizeUnicode(result.resources) };
  }

  /** Read a resource by URI (MCP resources capability). */
  async readResource(uri: string): Promise<{ contents: unknown }> {
    const result = await this.connection.callWithReconnect(client =>
      client.readResource({ uri }, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );
    return { contents: recursivelySanitizeUnicode(result.contents) };
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
