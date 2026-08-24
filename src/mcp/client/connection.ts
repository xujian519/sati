/**
 * src/mcp/client — MCP 连接状态机（connection lifecycle）。
 *
 * 从 McpClient.ts 拆出（A8 轮次 2）：8 个连接状态字段 + start/runConnect/
 * requireClient/callWithReconnect/reconnect/recycleTransportAfterTimeout/
 * close/cleanupSessionDir/peekInstructions。
 *
 * 核心不变式（并发正确性，勿当可重排代码）：
 * - reconnect / recycleTransportAfterTimeout 先**同步置空**
 *   client/transport/connectPromise/perSessionDir 引用，再 await 旧连接 close——
 *   竞态调用者要么触发新连接（connectPromise 为 null），要么等新的 in-flight，
 *   绝不触碰正在关闭的客户端；
 * - reconnectInFlight 单飞守卫：callWithReconnect 的会话过期重试恰好一次；
 * - listToolsCache 与连接生命周期强绑定（reconnect/recycle/close 失效），随迁。
 */

import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SatiMcpServerSpec, SatiMcpStatus, SatiMcpToolSpec } from "../protocol/types.js";
import { APP_VERSION } from "../../version.js";
import { McpClientError, isSessionExpired, withTimeout } from "./errors.js";
import { buildTransport, type TransportBuildOptions } from "./transport.js";

export type ListToolsCache = {
  expiresAt: number;
  tools: SatiMcpToolSpec[];
};

export class McpConnection {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private status: SatiMcpStatus = "idle";
  private listToolsCache: ListToolsCache | null = null;
  private serverInstructions = "";
  private connectPromise: Promise<void> | null = null;
  private reconnectInFlight = false;
  private perSessionDir: string | null = null;

  constructor(
    private readonly spec: SatiMcpServerSpec,
    private readonly options: TransportBuildOptions,
  ) {}

  getStatus(): SatiMcpStatus {
    return this.status;
  }

  getInstructions(): string {
    return this.serverInstructions;
  }

  /** tools/list LRU 缓存（reconnect/recycle/close 时失效，随连接生命周期）。 */
  getToolsCache(): ListToolsCache | null {
    return this.listToolsCache;
  }

  setToolsCache(cache: ListToolsCache | null): void {
    this.listToolsCache = cache;
  }

  /** M1 — memoized connect. */
  async start(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.runConnect();
    try {
      await this.connectPromise;
    } catch (err) {
      this.connectPromise = null;
      throw err;
    }
  }

  private async runConnect(): Promise<void> {
    this.status = "connecting";
    const built = buildTransport(this.spec, this.options);
    const transport = built.transport;
    if (built.perSessionDir !== null) this.perSessionDir = built.perSessionDir;
    const client = new Client({ name: "sati", version: APP_VERSION }, { capabilities: { elicitation: {} } });
    const handshakeMs = this.options.handshakeTimeoutMs ?? 10_000;
    try {
      await withTimeout(
        client.connect(transport),
        handshakeMs,
        () =>
          new McpClientError(
            `MCP handshake timed out after ${handshakeMs}ms (server=${this.spec.id})`,
            "mcp_handshake_failed",
            this.spec.id,
          ),
      );
    } catch (err) {
      this.status = "error";
      // The timed-out `client.connect()` keeps running in the background; drop
      // the half-open connection so the stdio subprocess does not leak. Both
      // closes are fire-and-forget — we must rethrow immediately.
      void client.close().catch(() => {});
      void transport.close().catch(() => {});
      throw err instanceof McpClientError
        ? err
        : new McpClientError(`MCP handshake failed: ${(err as Error).message}`, "mcp_handshake_failed", this.spec.id);
    }
    this.client = client;
    this.transport = transport;
    this.status = "ready";
    const instructions =
      client.getInstructions() ??
      (client.getServerCapabilities() as { instructions?: string } | undefined)?.instructions;
    this.serverInstructions = typeof instructions === "string" ? instructions : (this.peekInstructions(client) ?? "");
  }

  private peekInstructions(client: Client): string | undefined {
    // `getInstructions()` is the public API since SDK 1.29; `_instructions` /
    // `_serverInstructions` are internal fallbacks for older SDK builds.
    const raw = client as unknown as { _instructions?: string; _serverInstructions?: string };
    const value = raw._instructions ?? raw._serverInstructions;
    return typeof value === "string" ? value : undefined;
  }

  /** Ensure a live connection and return the SDK client, narrowed. */
  async requireClient(): Promise<Client> {
    await this.start();
    if (!this.client) {
      throw new McpClientError("Client not connected", "mcp_handshake_failed", this.spec.id);
    }
    return this.client;
  }

  /**
   * M5 + M15 wrapper. Resolves the *current* client on every invocation, so
   * after a reconnect the retried call uses the fresh connection, never a
   * stale reference. Triggers exactly one reconnect on session-expired errors.
   */
  async callWithReconnect<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    try {
      const client = await this.requireClient();
      return await fn(client);
    } catch (err) {
      if (isSessionExpired(err) && !this.reconnectInFlight) {
        this.reconnectInFlight = true;
        try {
          await this.reconnect();
          const client = await this.requireClient();
          return await fn(client);
        } finally {
          this.reconnectInFlight = false;
        }
      }
      if (err instanceof McpClientError) throw err;
      const e = err as Error & { code?: number };
      if (e.code === -32001 || /timed out|timeout/i.test(e.message ?? "")) {
        this.recycleTransportAfterTimeout();
        throw new McpClientError(
          `MCP call timed out (server=${this.spec.id}): ${e.message}`,
          "mcp_call_timeout",
          this.spec.id,
        );
      }
      throw new McpClientError(
        `MCP call failed (server=${this.spec.id}): ${e.message ?? "unknown"}`,
        "mcp_call_failed",
        this.spec.id,
      );
    }
  }

  /**
   * M5b — drop the wedged transport so the next call spawns a fresh
   * subprocess.
   *
   * `-32001` only cancels the client's wait; the server-side request often
   * keeps running. For long-running stdio MCPs (notably `@playwright/mcp`
   * blocked inside `page.goto` on a dead TCP connection) the subprocess
   * stays stuck and every subsequent call from the same session also
   * times out. We null out local refs synchronously — so any caller racing
   * into `start()` opens a brand-new connection — and close + clean up
   * the old transport asynchronously in the background.
   */
  private recycleTransportAfterTimeout(): void {
    const oldClient = this.client;
    const oldDir = this.perSessionDir;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
    this.listToolsCache = null;
    this.perSessionDir = null;
    this.status = "error";
    void (async () => {
      try {
        await oldClient?.close();
      } catch {
        // 子进程已僵死：close 失败可忽略，引用已同步置空，下轮调用重建连接（best-effort）。
      }
      if (oldDir) this.cleanupSessionDir(oldDir);
    })();
  }

  /** M5 — close the existing client and reconnect. */
  private async reconnect(): Promise<void> {
    this.status = "connecting";
    this.listToolsCache = null;
    // Null out local refs *synchronously* before awaiting the old client's
    // close: while `close()` is in flight, a concurrent `callTool`/`listTools`
    // would otherwise `await start()`, see the stale resolved connectPromise
    // and call into a half-closed client. Refs are dropped first, so racing
    // callers either start a fresh connection (connectPromise is null) or
    // wait on the new in-flight one — never touch the dying client.
    const oldClient = this.client;
    const oldDir = this.perSessionDir;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
    this.perSessionDir = null;
    try {
      await oldClient?.close();
    } catch {
      // 重连时旧连接关闭失败：引用已置空，竞态调用者不会触碰旧 client，忽略是安全的（fail-safe）。
    }
    if (oldDir) this.cleanupSessionDir(oldDir);
    await this.start();
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // 关闭失败：状态随即重置为 idle，引用置空，下次调用会新建连接（fail-safe）。
    }
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
    this.status = "idle";
    this.listToolsCache = null;
    if (this.perSessionDir) {
      this.cleanupSessionDir(this.perSessionDir);
      this.perSessionDir = null;
    }
  }

  private cleanupSessionDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 会话目录清理失败：留待下次或系统回收，不影响连接生命周期（best-effort）。
    }
  }
}
