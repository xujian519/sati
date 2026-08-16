/**
 * src/mcp/client — MCP RPC 包装（operations）。
 *
 * 从 McpClient.ts 拆出（A9 轮次 3）：listTools（LRU 缓存）/ callTool /
 * listResources / readResource 四个 RPC 包装，经 McpConnection 执行
 * （连接 + 会话过期重连 + 超时回收由 connection 承担）。
 */

import { recursivelySanitizeUnicode } from "../runtime/sanitize.js";
import type { SatiMcpResource, SatiMcpServerSpec, SatiMcpToolSpec } from "../protocol/types.js";
import { toToolSpec } from "./toolSpec.js";
import { DEFAULT_CALL_TIMEOUT_MS, type TransportBuildOptions } from "./transport.js";
import type { McpConnection } from "./connection.js";

const LIST_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;

export class McpClientOperations {
  constructor(
    private readonly spec: SatiMcpServerSpec,
    private readonly options: TransportBuildOptions,
    private readonly connection: McpConnection,
  ) {}

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
}
