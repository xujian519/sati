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
 */

import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { recursivelySanitizeUnicode } from "../runtime/sanitize.js";
import type { SatiMcpResource, SatiMcpServerSpec, SatiMcpStatus, SatiMcpToolSpec } from "../protocol/types.js";
import { APP_VERSION } from "../../version.js";
import { McpClientError, isSessionExpired, withTimeout } from "./errors.js";
import { toToolSpec } from "./toolSpec.js";
import { buildTransport, DEFAULT_CALL_TIMEOUT_MS } from "./transport.js";

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

type ListToolsCache = {
  expiresAt: number;
  tools: SatiMcpToolSpec[];
};

export class McpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private status: SatiMcpStatus = "idle";
  private listToolsCache: ListToolsCache | null = null;
  private serverInstructions = "";
  private connectPromise: Promise<void> | null = null;
  private reconnectInFlight = false;
  private perSessionDir: string | null = null;

  constructor(
    public readonly spec: SatiMcpServerSpec,
    private readonly options: McpClientOptions = {},
  ) {}

  getStatus(): SatiMcpStatus {
    return this.status;
  }

  getInstructions(): string {
    return this.serverInstructions;
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

  /** M6 — LRU-cached tools/list. */
  async listTools(): Promise<SatiMcpToolSpec[]> {
    const cached = this.listToolsCache;
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    const sdkResult = await this.callWithReconnect(client =>
      client.listTools(undefined, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );

    const tools = (sdkResult.tools ?? []).map((tool: unknown) => toToolSpec(tool, this.spec.id));
    this.listToolsCache = {
      tools,
      expiresAt: Date.now() + LIST_TOOLS_CACHE_TTL_MS,
    };
    return tools;
  }

  /** M3 + M5 + M14 + M15 — call a tool with timeout + auto-reconnect once. */
  async callTool(
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ content: unknown; isError?: boolean }> {
    const timeoutMs = options.timeoutMs ?? this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const result = await this.callWithReconnect(client =>
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
    const result = await this.callWithReconnect(client =>
      client.listResources(undefined, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );
    return { resources: recursivelySanitizeUnicode(result.resources) };
  }

  /** Read a resource by URI (MCP resources capability). */
  async readResource(uri: string): Promise<{ contents: unknown }> {
    const result = await this.callWithReconnect(client =>
      client.readResource({ uri }, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );
    return { contents: recursivelySanitizeUnicode(result.contents) };
  }

  /** Ensure a live connection and return the SDK client, narrowed. */
  private async requireClient(): Promise<Client> {
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
  private async callWithReconnect<T>(fn: (client: Client) => Promise<T>): Promise<T> {
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
        // best effort — the subprocess may already be wedged
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
      // ignore close errors during reconnect
    }
    if (oldDir) this.cleanupSessionDir(oldDir);
    await this.start();
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // best effort
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
      // best effort cleanup
    }
  }
}
