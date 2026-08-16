/**
 * src/mcp/client — MCP 客户端错误类型与工具函数。
 *
 * 从 McpClient.ts 拆出（A6 轮次 1）：错误类 + 会话过期判定 + 超时包装，
 * 零状态纯件。
 */

export class McpClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "mcp_handshake_failed"
      | "mcp_call_timeout"
      | "mcp_session_expired"
      | "mcp_call_failed"
      | "mcp_unsupported_transport",
    public readonly serverId?: string,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

/** 会话过期判定：statusCode 404 或 message 含 /session.*expired/i。 */
export function isSessionExpired(err: unknown): boolean {
  const e = err as { code?: number; message?: string; statusCode?: number } | null;
  if (!e) return false;
  if (e.statusCode === 404) return true;
  return /session.*expired/i.test(e.message ?? "");
}

/** 给 promise 套超时（超时用 errorFactory 构造的错误拒绝）。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorFactory: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), timeoutMs);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
