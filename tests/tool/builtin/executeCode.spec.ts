import assert from "node:assert/strict";
import test from "node:test";
import { connect, type Socket } from "node:net";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { SatiToolResult } from "../../../src/tool/protocol/result.js";
import { createExecuteCodeTool } from "../../../src/tool/builtin/executeCode.js";
import { createRpcServer, handleExecuteCodeRpcLineForTests } from "../../../src/tool/builtin/executeCodeRpc.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { makeToolContext } from "../context-fixture.js";

function makeRpcContext(): SatiToolRuntimeContext {
  return makeToolContext({
    sessionId: "test-session",
    turnId: "test-turn",
    permissionContext: {
      mode: "bypassPermissions",
      rules: { allow: [], deny: [], ask: [] },
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
  });
}

function successResult(text: string): SatiToolResult {
  return {
    type: "success",
    toolCallId: "call_1",
    toolName: "echo",
    content: [{ type: "text", text }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

type RpcTestResponse = { content?: string; error?: string; code?: string };

function inputText(call: { input: unknown }): string {
  if (typeof call.input !== "object" || call.input === null) return "";
  const record = call.input as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : "";
}

/** 起一个真实 TCP RPC server，把 client 交给测试体，结束后清理。 */
async function withRpcServer(
  executeTool: NonNullable<SatiToolRuntimeContext["executeTool"]>,
  fn: (client: Socket) => Promise<void>,
): Promise<void> {
  const server = createRpcServer({
    context: makeRpcContext(),
    executeTool,
    maxToolCalls: 50,
    toolCallLog: [],
    nextToolCall: (() => {
      let next = 0;
      return () => (next += 1);
    })(),
    canCallTool: () => true,
    allowedTools: new Set(["echo"]),
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = connect({ host: "127.0.0.1", port: address.port });
  // 等待 TCP 握手完成再让测试体写入，避免并发负载下 write 与 connect 竞态
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  try {
    await fn(client);
  } finally {
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function sendLine(socket: Socket, line: string): Promise<void> {
  return new Promise(resolve => {
    socket.write(`${line}\n`, () => resolve());
  });
}

/**
 * 基于共享缓冲区的行读取器：多个响应可能在同一 TCP chunk 中到达，
 * 必须缓存未消费的部分，否则后续 readLine 会永久等待。
 * 注意：数据先于 readLine 注册 waiter 到达时，行必须留在 buffer 中
 * 等待后续读取，不能因"暂无等待者"而丢弃。
 */
function createLineReader(socket: Socket): () => Promise<string> {
  let buffer = "";
  const pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (pending.length > 0) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      pending.shift()!.resolve(line);
    }
  });
  socket.on("error", (error: Error) => {
    for (const waiter of pending) waiter.reject(error);
    pending.length = 0;
  });
  return () =>
    new Promise<string>((resolve, reject) => {
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        resolve(line);
        return;
      }
      pending.push({ resolve, reject });
    });
}

test("execute_code read-only probe handles missing input", () => {
  const tool = createExecuteCodeTool();

  assert.equal(tool.isReadOnly({} as unknown as Parameters<typeof tool.isReadOnly>[0]), false);
});

test("disabling web search removes it from the registry but keeps web fetch", () => {
  const registry = createBuiltinRegistry({ webSearch: false });

  assert.equal(registry.has("web_search"), false);
  assert.equal(registry.has("WebSearch"), false);
  assert.equal(registry.has("web_fetch"), true);
  assert.doesNotMatch(registry.get("execute_code")?.description ?? "", /\bweb_search\b/);
  assert.match(registry.get("execute_code")?.description ?? "", /\bweb_fetch\b/);
});

test("execute_code rejects nested web search calls when web search is disabled", async () => {
  let executed = false;
  const response = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ tool: "web_search", args: { query: "hello" } }),
    {
      webSearch: false,
      executeTool: async () => {
        executed = true;
        throw new Error("web_search should not be invoked");
      },
    },
  );

  assert.equal(response.code, "tool_not_allowed");
  assert.equal(executed, false);
});

test("RPC 返回 rpc_internal_error 而非挂起：嵌套工具抛异常仍有响应", async () => {
  await withRpcServer(
    async () => {
      throw new Error("boom");
    },
    async client => {
      const readLine = createLineReader(client);
      await sendLine(client, JSON.stringify({ tool: "echo", args: {} }));
      const response = JSON.parse(await readLine()) as RpcTestResponse;

      assert.equal(response.code, "rpc_internal_error");
      assert.match(response.error ?? "", /boom/);
    },
  );
});

test("RPC 正常路径返回工具结果内容", async () => {
  await withRpcServer(
    async call => {
      assert.equal(call.name, "echo");
      return successResult(`echo:${inputText(call)}`);
    },
    async client => {
      const readLine = createLineReader(client);
      await sendLine(client, JSON.stringify({ tool: "echo", args: { text: "hi" } }));
      const response = JSON.parse(await readLine()) as RpcTestResponse;

      assert.equal(response.code, undefined);
      assert.equal(response.content, "echo:hi");
    },
  );
});

test("RPC 一次到达多个请求时按序响应（串行化不丢请求）", async () => {
  const calls: string[] = [];
  await withRpcServer(
    async call => {
      calls.push(inputText(call));
      return successResult(`ok:${inputText(call)}`);
    },
    async client => {
      const readLine = createLineReader(client);
      const payload =
        `${JSON.stringify({ tool: "echo", args: { text: "1" } })}\n` +
        `${JSON.stringify({ tool: "echo", args: { text: "2" } })}\n`;
      client.write(payload);

      const first = JSON.parse(await readLine()) as RpcTestResponse;
      const second = JSON.parse(await readLine()) as RpcTestResponse;

      assert.equal(first.content, "ok:1");
      assert.equal(second.content, "ok:2");
      assert.deepEqual(calls, ["1", "2"]);
    },
  );
});
