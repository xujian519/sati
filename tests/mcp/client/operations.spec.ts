import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpClient } from "../../../src/mcp/client/McpClient.js";
import { McpClientError } from "../../../src/mcp/client/errors.js";

/** 带调用计数的 Fake Transport（tools/list、tools/call 计数）。 */
function createCountingTransport(): Transport & { listToolsCalls: number; failCall: boolean } {
  let onmessage: Transport["onmessage"];
  const transport: Transport & { listToolsCalls: number; failCall: boolean } = {
    listToolsCalls: 0,
    failCall: false,
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
          transport.listToolsCalls += 1;
          respond({ tools: [{ name: "t1", description: "工具一", inputSchema: { type: "object" } }] });
          break;
        case "tools/call":
          if (transport.failCall) {
            onmessage?.({
              jsonrpc: "2.0",
              id: m.id,
              error: { code: -32603, message: "boom" },
            } as JSONRPCMessage);
            return;
          }
          respond({ content: [{ type: "text", text: "ok" }] });
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

function createClient(): { client: McpClient; transport: ReturnType<typeof createCountingTransport> } {
  const transport = createCountingTransport();
  const client = new McpClient(
    { id: "ops-test", transport: "stdio", command: "node" },
    { transportFactory: () => transport },
  );
  return { client, transport };
}

test("operations: listTools 缓存命中（TTL 内 tools/list 只发一次）", async () => {
  const { client, transport } = createClient();
  const first = await client.listTools();
  const second = await client.listTools();
  assert.equal(first.length, 1);
  assert.equal(second, first, "缓存命中应返回同一数组引用");
  assert.equal(transport.listToolsCalls, 1, "TTL 内第二次 listTools 应命中缓存");
});

test("operations: listTools 缓存 TTL 过期后重取", async () => {
  const { client, transport } = createClient();
  await client.listTools();
  // 直接清缓存（等价 TTL 过期；connection 暴露 setToolsCache）
  (client as unknown as { connection: { setToolsCache(c: null): void } }).connection.setToolsCache(null);
  const again = await client.listTools();
  assert.equal(again.length, 1);
  assert.equal(transport.listToolsCalls, 2, "缓存失效后应重新请求");
});

test("operations: callTool 通用错误映射 mcp_call_failed", async () => {
  const { client, transport } = createClient();
  transport.failCall = true;
  await assert.rejects(
    client.callTool("t1", {}),
    (err: unknown) => err instanceof McpClientError && err.code === "mcp_call_failed",
  );
});
