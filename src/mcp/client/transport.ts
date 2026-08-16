/**
 * src/mcp/client — MCP 传输工厂（stdio / streamable_http）。
 *
 * 从 McpClient.ts 拆出（A6 轮次 1）：传输构造 + fetch 超时/重试路由；
 * perSession 临时目录经返回值带出（不再写 this，消除状态耦合）。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { networkFetch } from "../../network/fetch.js";
import { brandEnv, ENV_KEY } from "../../env.js";
import type { SatiMcpServerSpec } from "../protocol/types.js";
import { McpClientError } from "./errors.js";

export const DEFAULT_CALL_TIMEOUT_MS = parseInt(brandEnv(process.env, ENV_KEY.MCP_TOOL_TIMEOUT_MS) ?? "60000", 10);

export type TransportBuildOptions = {
  callTimeoutMs?: number;
  /** Connect handshake timeout. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Optional override for testing — supply a pre-built Transport instance. */
  transportFactory?: (spec: SatiMcpServerSpec) => Transport;
  /** Optional fetch override for testing streamable HTTP transports. */
  fetch?: typeof fetch;
};

/** 构造传输；stdio perSession 时创建临时目录并经返回值带出（调用方负责清理）。 */
export function buildTransport(
  spec: SatiMcpServerSpec,
  options: TransportBuildOptions,
): { transport: Transport; perSessionDir: string | null } {
  if (options.transportFactory) {
    return { transport: options.transportFactory(spec), perSessionDir: null };
  }
  if (spec.transport === "stdio") {
    let args = spec.args;
    let perSessionDir: string | null = null;
    if (spec.perSession) {
      const dir = mkdtempSync(join(tmpdir(), `sati-mcp-${spec.id}-`));
      perSessionDir = dir;
      args = [...(args ?? []), `--user-data-dir=${dir}`];
    }
    return {
      transport: new StdioClientTransport({
        command: spec.command,
        args,
        env: spec.env,
        cwd: spec.cwd,
      }),
      perSessionDir,
    };
  }
  if (spec.transport === "streamable_http") {
    const url = new URL(spec.url);
    return {
      transport: new StreamableHTTPClientTransport(url, {
        requestInit: { headers: spec.headers ?? {} },
        fetch: (input, init) => {
          const method = String(init?.method ?? "GET").toUpperCase();
          const fetchImpl = options.fetch;
          return (fetchImpl ?? networkFetch)(input as RequestInfo, init, {
            timeoutMs:
              method === "POST"
                ? (options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)
                : (options.handshakeTimeoutMs ?? 10_000),
            retry: {
              maxRetries: 1,
              baseDelayMs: 500,
              maxDelayMs: 5_000,
            },
          });
        },
      }),
      perSessionDir: null,
    };
  }
  const fallback = spec as SatiMcpServerSpec;
  throw new McpClientError(
    `Unsupported transport: ${(fallback as { transport: string }).transport}`,
    "mcp_unsupported_transport",
    fallback.id,
  );
}
