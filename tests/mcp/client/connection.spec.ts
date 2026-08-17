import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpConnection } from "../../../src/mcp/client/connection.js";
import { McpClientError } from "../../../src/mcp/client/errors.js";

/**
 * Fake Transport 应答 SDK 握手；可选控制 listTools / callTool 的响应与错误。
 */
function createFakeTransport(
  opts: { onListTools?: () => unknown | Promise<unknown>; onCallTool?: () => unknown | Promise<unknown> } = {},
): Transport {
  let onmessage: Transport["onmessage"];
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      const m = message as { id?: number | string; method?: string; params?: { name?: string } };
      if (m.id === undefined) return;
      const respond = (result: unknown) => onmessage?.({ jsonrpc: "2.0", id: m.id, result } as JSONRPCMessage);
      switch (m.method) {
        case "initialize":
          respond({
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1.0.0" },
          });
          break;
        case "tools/list":
          respond(opts.onListTools?.() ?? { tools: [] });
          break;
        case "tools/call":
          respond(opts.onCallTool?.() ?? { content: [] });
          break;
        default:
          respond({});
      }
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

function createConnection(opts: { onCallTool?: () => unknown } = {}): McpConnection {
  return new McpConnection(
    { id: "conn-test", transport: "stdio", command: "node", args: ["server.js"] },
    { transportFactory: () => createFakeTransport({ onCallTool: opts.onCallTool }) },
  );
}

test("connection: start 幂等（memoized connect，transportFactory 只调一次）", async () => {
  let factoryCalls = 0;
  const conn = new McpConnection(
    { id: "m1", transport: "stdio", command: "node" },
    {
      transportFactory: () => {
        factoryCalls += 1;
        return createFakeTransport();
      },
    },
  );
  await conn.start();
  await conn.start();
  assert.equal(factoryCalls, 1);
  assert.equal(conn.getStatus(), "ready");
});

test("connection: start 失败后重置 connectPromise（下次重试）", async () => {
  let failFirst = true;
  const conn = new McpConnection(
    { id: "m2", transport: "stdio", command: "node" },
    {
      transportFactory: () => {
        if (failFirst) {
          failFirst = false;
          // 握手超时路径：connect 永不应答 → withTimeout 10ms 拒绝
          const stuck: Transport = {
            async start() {},
            async send() {},
            async close() {},
            set onmessage(_fn) {},
            get onmessage() {
              return undefined as unknown as Transport["onmessage"];
            },
          };
          return stuck;
        }
        return createFakeTransport();
      },
    },
  );
  await assert.rejects(conn.start(), err => err instanceof McpClientError && err.code === "mcp_handshake_failed");
  assert.equal(conn.getStatus(), "error");
  await conn.start();
  assert.equal(conn.getStatus(), "ready", "失败后应可重试成功");
});

test("connection: close 幂等且复位状态与缓存", async () => {
  const conn = createConnection();
  await conn.start();
  conn.setToolsCache({ expiresAt: Date.now() + 60_000, tools: [] });
  await conn.close();
  await conn.close();
  assert.equal(conn.getStatus(), "idle");
  assert.equal(conn.getToolsCache(), null, "close 应清空 tools 缓存");
});

test("connection: callWithReconnect 会话过期恰好重连一次（single-flight）", async () => {
  let calls = 0;
  let expiredOnce = true;
  const conn = createConnection({
    onCallTool: () => {
      calls += 1;
      if (expiredOnce) {
        expiredOnce = false;
        const err = new Error("Session expired") as Error & { code?: number; statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const result = (await conn.callWithReconnect(client =>
    client.callTool({ name: "t", arguments: {} }, undefined, { timeout: 5_000 }),
  )) as { content: Array<{ type?: string; text?: string }> };
  assert.equal(result.content[0]?.text, "ok");
  assert.equal(calls, 2, "会话过期应重连后重试一次");
});

test("connection: -32001 超时回收 transport（下次调用新建连接）", async () => {
  let callAttempts = 0;
  const conn = createConnection({
    onCallTool: () => {
      callAttempts += 1;
      if (callAttempts === 1) {
        const err = new Error("Request timed out") as Error & { code?: number };
        err.code = -32001;
        throw err;
      }
      return { content: [{ type: "text", text: "recovered" }] };
    },
  });
  await assert.rejects(
    conn.callWithReconnect(client => client.callTool({ name: "t", arguments: {} }, undefined, { timeout: 5_000 })),
    err => err instanceof McpClientError && err.code === "mcp_call_timeout",
  );
  assert.equal(conn.getStatus(), "error", "超时回收后状态为 error");
  // 下一次调用：新建连接成功
  const result = (await conn.callWithReconnect(client =>
    client.callTool({ name: "t", arguments: {} }, undefined, { timeout: 5_000 }),
  )) as { content: Array<{ type?: string; text?: string }> };
  assert.equal(result.content[0]?.text, "recovered");
  assert.equal(callAttempts, 2);
});
