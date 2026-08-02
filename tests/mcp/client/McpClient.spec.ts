import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpClient, McpClientError } from "../../../src/mcp/client/McpClient.js";

test("McpClient keeps stdio clients idle before connection", () => {
  const client = new McpClient({ id: "stdio-test", transport: "stdio", command: "node" });
  assert.equal(client.getStatus(), "idle");
});

test("McpClient constructs streamable_http transport without requiring stdio fields", () => {
  const client = new McpClient({ id: "http-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" });
  assert.equal(client.getStatus(), "idle");
});

test("McpClient routes streamable_http fetches with bounded timeouts", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit; timeoutMs?: number }> = [];
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: { timeoutMs?: number },
  ): Promise<Response> => {
    calls.push({ input, init, timeoutMs: options?.timeoutMs });
    return new Response("{}");
  };
  const client = new McpClient(
    { id: "http-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" },
    { callTimeoutMs: 12_345, handshakeTimeoutMs: 2_345, fetch: fetchImpl as typeof fetch },
  );

  const transport = (client as unknown as { buildTransport(): unknown }).buildTransport();
  assert.ok(transport instanceof StreamableHTTPClientTransport);
  const transportFetch = (transport as unknown as { _fetch?: typeof fetch })._fetch;
  assert.equal(typeof transportFetch, "function");

  await transportFetch?.("https://mcp.example.test/mcp", { method: "GET" });
  assert.equal(calls.at(-1)?.timeoutMs, 2_345);

  await transportFetch?.("https://mcp.example.test/mcp", { method: "POST" });
  assert.equal(calls.at(-1)?.timeoutMs, 12_345);
});

/**
 * Fake Transport that answers the SDK client handshake in-process.
 * Only used to exercise post-connect behaviour without a subprocess.
 */
function createFakeTransport(instructions?: string): Transport {
  let onmessage: Transport["onmessage"];
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      const m = message as { id?: number | string; method?: string };
      if (m.id === undefined || m.method !== "initialize") return;
      onmessage?.({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
          ...(instructions !== undefined ? { instructions } : {}),
        },
      } as JSONRPCMessage);
    },
    async close() {},
    set onmessage(fn) {
      onmessage = fn;
    },
    get onmessage() {
      return onmessage as Transport["onmessage"];
    },
  };
  return transport;
}

test("McpClient reads server instructions from the SDK after connect", async () => {
  const client = new McpClient(
    { id: "instr", transport: "stdio", command: "node" },
    { transportFactory: () => createFakeTransport("Follow the style guide.") },
  );
  assert.equal(client.getStatus(), "idle");
  assert.equal(client.getInstructions(), "");
  await client.start();
  assert.equal(client.getStatus(), "ready");
  assert.equal(client.getInstructions(), "Follow the style guide.");
  await client.close();
});

test("McpClient tolerates servers that do not advertise instructions", async () => {
  const client = new McpClient(
    { id: "quiet", transport: "stdio", command: "node" },
    { transportFactory: () => createFakeTransport() },
  );
  await client.start();
  assert.equal(client.getInstructions(), "");
  await client.close();
});

/** Fake Transport that answers the SDK client handshake + resource calls. */
function createResourceTransport(resources: unknown[]): Transport {
  let onmessage: Transport["onmessage"];
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      const m = message as { id?: number | string; method?: string; params?: { uri?: string } };
      if (m.id === undefined || m.method === undefined) return;
      let result: unknown;
      if (m.method === "initialize") {
        result = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
        };
      } else if (m.method === "resources/list") {
        result = { resources };
      } else if (m.method === "resources/read") {
        result = { contents: [{ uri: m.params?.uri, text: `text:${m.params?.uri}` }] };
      } else {
        return;
      }
      onmessage?.({ jsonrpc: "2.0", id: m.id, result } as JSONRPCMessage);
    },
    async close() {},
    set onmessage(fn) {
      onmessage = fn;
    },
    get onmessage() {
      return onmessage as Transport["onmessage"];
    },
  };
  return transport;
}

test("McpClient lists resources advertised by the server", async () => {
  const client = new McpClient(
    { id: "res", transport: "stdio", command: "node" },
    { transportFactory: () => createResourceTransport([{ uri: "file:///a.txt", name: "a" }]) },
  );
  await client.start();
  const result = await client.listResources();
  assert.deepEqual(result.resources, [{ uri: "file:///a.txt", name: "a" }]);
  await client.close();
});

test("McpClient reads a resource by URI", async () => {
  const client = new McpClient(
    { id: "res", transport: "stdio", command: "node" },
    { transportFactory: () => createResourceTransport([]) },
  );
  await client.start();
  const result = await client.readResource("file:///x.txt");
  assert.deepEqual(result.contents, [{ uri: "file:///x.txt", text: "text:file:///x.txt" }]);
  await client.close();
});

test("McpClient handshake timeout fails fast and marks the client errored", async () => {
  const hangingTransport: Transport = {
    start: () => new Promise<void>(() => {}), // never resolves
    send: async () => {},
    close: async () => {},
  };
  const client = new McpClient(
    { id: "slow", transport: "stdio", command: "node" },
    { handshakeTimeoutMs: 50, transportFactory: () => hangingTransport },
  );
  await assert.rejects(
    () => client.start(),
    (err: unknown) => {
      assert.ok(err instanceof McpClientError);
      assert.equal(err.code, "mcp_handshake_failed");
      assert.match(err.message, /timed out after 50ms/);
      return true;
    },
  );
  assert.equal(client.getStatus(), "error");
  await client.close();
});

/**
 * Fake Transport whose `tools/call` answers with a session-expired error on
 * the first server-side call and succeeds afterwards. `serverState` is shared
 * across connections to model server-side session state surviving reconnects.
 */
function createSessionExpiryTransport(serverState: { calls: number }): Transport {
  let onmessage: Transport["onmessage"];
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      const m = message as { id?: number | string; method?: string; params?: { name?: string } };
      if (m.id === undefined || m.method === undefined) return;
      let result: unknown;
      if (m.method === "initialize") {
        result = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
        };
      } else if (m.method === "tools/call") {
        serverState.calls += 1;
        if (serverState.calls === 1) {
          // The first server-side call answers with a session-expired error.
          onmessage?.({
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32601, message: "session expired" },
          } as JSONRPCMessage);
          return;
        }
        result = { content: [{ type: "text", text: "recovered" }] };
      } else {
        return;
      }
      onmessage?.({ jsonrpc: "2.0", id: m.id, result } as JSONRPCMessage);
    },
    async close() {},
    set onmessage(fn) {
      onmessage = fn;
    },
    get onmessage() {
      return onmessage as Transport["onmessage"];
    },
  };
  return transport;
}

test("McpClient retries the call on a fresh connection after session expiry (M5)", async () => {
  let connections = 0;
  const serverState = { calls: 0 };
  const client = new McpClient(
    { id: "session", transport: "stdio", command: "node" },
    {
      transportFactory: () => {
        connections += 1;
        return createSessionExpiryTransport(serverState);
      },
    },
  );
  const result = await client.callTool("echo", { message: "hi" });
  assert.deepEqual(result.content, [{ type: "text", text: "recovered" }]);
  assert.equal(result.isError, undefined);
  // One connection for the original call + one fresh connection after reconnect.
  assert.equal(connections, 2);
  assert.equal(client.getStatus(), "ready");
  await client.close();
});
