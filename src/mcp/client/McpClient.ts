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
 * - M6 LRU-caches the result of `listTools()` for `LRU_TTL_MS` (5 min).
 *   Cache is invalidated on reconnect.
 *
 * Errors raised by `callTool` / `listTools` always carry one of the
 * PolitDeck-style `mcp_*` error codes via the `code` field on the thrown
 * error, so the caller can map them back to `PolitDeckToolErrorCode`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { recursivelySanitizeUnicode } from "../runtime/sanitize.js";
import { truncateMcpToolDescription } from "../runtime/truncate.js";
import { buildMcpToolWireName } from "../runtime/wireName.js";
import type {
  PolitDeckMcpServerSpec,
  PolitDeckMcpStatus,
  PolitDeckMcpToolSpec,
} from "../protocol/types.js";

const DEFAULT_CALL_TIMEOUT_MS = parseInt(
  process.env.POLITDECK_MCP_TOOL_TIMEOUT_MS ?? "60000",
  10,
);
const LIST_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;

export type McpClientOptions = {
  callTimeoutMs?: number;
  /** Connect handshake timeout. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Optional override for testing — supply a pre-built Transport instance. */
  transportFactory?: (spec: PolitDeckMcpServerSpec) => Transport;
};

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

type ListToolsCache = {
  expiresAt: number;
  tools: PolitDeckMcpToolSpec[];
};

export class McpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private status: PolitDeckMcpStatus = "idle";
  private listToolsCache: ListToolsCache | null = null;
  private serverInstructions = "";
  private connectPromise: Promise<void> | null = null;
  private reconnectInFlight = false;

  constructor(
    public readonly spec: PolitDeckMcpServerSpec,
    private readonly options: McpClientOptions = {},
  ) {}

  getStatus(): PolitDeckMcpStatus {
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
    const transport = this.buildTransport();
    const client = new Client(
      { name: "politdeck", version: "0.1.0" },
      { capabilities: { elicitation: {} } },
    );
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
      throw err instanceof McpClientError
        ? err
        : new McpClientError(
            `MCP handshake failed: ${(err as Error).message}`,
            "mcp_handshake_failed",
            this.spec.id,
          );
    }
    this.client = client;
    this.transport = transport;
    this.status = "ready";
    const instructions = (client.getServerCapabilities() as { instructions?: string } | undefined)
      ?.instructions;
    this.serverInstructions =
      typeof instructions === "string"
        ? instructions
        : (this.peekInstructions(client) ?? "");
  }

  private peekInstructions(client: Client): string | undefined {
    const raw = (client as unknown as { _serverInstructions?: string })
      ._serverInstructions;
    return typeof raw === "string" ? raw : undefined;
  }

  private buildTransport(): Transport {
    if (this.options.transportFactory) {
      return this.options.transportFactory(this.spec);
    }
    if (this.spec.transport === "stdio") {
      return new StdioClientTransport({
        command: this.spec.command,
        args: this.spec.args,
        env: this.spec.env,
        cwd: this.spec.cwd,
      });
    }
    if (this.spec.transport === "streamable_http") {
      const url = new URL(this.spec.url);
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: this.spec.headers ?? {} },
      });
    }
    const fallback = this.spec as PolitDeckMcpServerSpec;
    throw new McpClientError(
      `Unsupported transport: ${(fallback as { transport: string }).transport}`,
      "mcp_unsupported_transport",
      fallback.id,
    );
  }

  /** M6 — LRU-cached tools/list. */
  async listTools(): Promise<PolitDeckMcpToolSpec[]> {
    const cached = this.listToolsCache;
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    await this.start();
    if (!this.client) {
      throw new McpClientError("Client not connected", "mcp_handshake_failed", this.spec.id);
    }
    const sdkResult = await this.callWithReconnect(() =>
      this.client!.listTools(undefined, { timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }),
    );

    const tools = (sdkResult.tools ?? []).map((tool: unknown) => this.toToolSpec(tool));
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
    await this.start();
    if (!this.client) {
      throw new McpClientError("Client not connected", "mcp_handshake_failed", this.spec.id);
    }
    const timeoutMs = options.timeoutMs ?? this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const result = await this.callWithReconnect(() =>
      this.client!.callTool(
        { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        {
          timeout: timeoutMs,
          signal: options.signal,
        },
      ),
    );
    return {
      content: recursivelySanitizeUnicode(result.content),
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
    };
  }

  /** M5 + M15 wrapper. Triggers exactly one reconnect on session-expired errors. */
  private async callWithReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.isSessionExpired(err) && !this.reconnectInFlight) {
        this.reconnectInFlight = true;
        try {
          await this.reconnect();
          return await fn();
        } finally {
          this.reconnectInFlight = false;
        }
      }
      if (err instanceof McpClientError) throw err;
      const e = err as Error & { code?: number };
      if (e.code === -32001 || /timed out|timeout/i.test(e.message ?? "")) {
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

  private isSessionExpired(err: unknown): boolean {
    const e = err as { code?: number; message?: string; statusCode?: number } | null;
    if (!e) return false;
    if (e.statusCode === 404) return true;
    return /session.*expired/i.test(e.message ?? "");
  }

  /** M5 — close the existing client and reconnect. */
  private async reconnect(): Promise<void> {
    this.status = "connecting";
    this.listToolsCache = null;
    try {
      await this.client?.close();
    } catch {
      // ignore close errors during reconnect
    }
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
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
  }

  private toToolSpec(raw: unknown): PolitDeckMcpToolSpec {
    const sanitized = recursivelySanitizeUnicode(raw) as {
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: PolitDeckMcpToolSpec["annotations"];
      _meta?: Record<string, unknown>;
    };
    const wireName = buildMcpToolWireName(this.spec.id, sanitized.name);
    return {
      serverId: this.spec.id,
      toolName: sanitized.name,
      wireName,
      description: truncateMcpToolDescription(sanitized.description ?? ""),
      inputSchema: sanitized.inputSchema ?? { type: "object", properties: {} },
      annotations: sanitized.annotations,
      meta: sanitized._meta,
    };
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
