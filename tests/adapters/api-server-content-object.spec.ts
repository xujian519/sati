import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { ApiServerChannel } from "../../src/adapters/channel/api-server/ApiServerChannel.js";
import { ApiServerSessionMapper } from "../../src/adapters/channel/api-server/ApiServerSessionMapper.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

/**
 * 上游 #561：`messages[].content` 为普通对象时必须显式 400，而不是 `String(obj)`
 * 变成字面量 `[object Object]` 继续往下走。
 *
 * 危害不在文案难看：调用方（脚本 / OpenAI 兼容客户端）把提示词写成 `{...}` 时，
 * 模型收到的是 `[object Object]`，回答牛头不对马嘴，而 HTTP 200 让调用方无从察觉。
 * 且该请求会照常占用会话槽位与 token 预算。
 */

type CapturedCall = Pick<GatewaySubmitTurnInput, "sessionKey" | "channelKey" | "message">;

function makeResponse() {
  const chunks: string[] = [];
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    headers,
    ended: false,
    get body() {
      return chunks.join("");
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
    },
    flushHeaders() {},
    write(chunk: string | Buffer) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk != null) chunks.push(String(chunk));
      this.ended = true;
    },
  };
}

function makeRequest(content: unknown, stream: boolean, sessionId: string): IncomingMessage {
  const body = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content }],
    stream,
  });
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  Object.assign(req, { method: "POST", url: "/v1/chat/completions" });
  req.headers = {
    host: "fixture.invalid",
    "content-type": "application/json",
    "x-hermes-session-id": sessionId,
  };
  return req;
}

function makeGateway(calls: CapturedCall[]): Gateway {
  return {
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncGenerator<GatewayEvent> {
      calls.push({
        sessionKey: input.sessionKey,
        channelKey: input.channelKey,
        message: input.message,
      });
      yield { type: "assistant_text_delta", text: "fixture-reply" } as GatewayEvent;
      yield {
        type: "turn_completed",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "completed",
      } as unknown as GatewayEvent;
    },
  } as unknown as Gateway;
}

async function runCase(content: unknown, stream: boolean, sessionId: string) {
  const calls: CapturedCall[] = [];
  const mapper = new ApiServerSessionMapper({ activeByChatId: {} }, () => "fixture-uuid");
  const channel = new ApiServerChannel({ mapper, modelName: "fixture-model" });
  const internals = channel as unknown as {
    gateway: Gateway;
    activeChats: Set<string>;
    handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  };
  internals.gateway = makeGateway(calls);

  const res = makeResponse();
  await internals.handleRequest(makeRequest(content, stream, sessionId), res as unknown as ServerResponse);
  return { calls, res, activeChats: internals.activeChats };
}

describe("api-server 对对象型 content 的处理", () => {
  it("任意普通对象被拒为 400 invalid_content，且不触达 Gateway", async () => {
    const { calls, res, activeChats } = await runCase({ kind: "fixture-object", value: 7 }, false, "fixture-561-A");

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(res.body, /\[object Object\]/);
    assert.equal(JSON.parse(res.body).error?.code, "invalid_content");
    assert.equal(activeChats.size, 0);
  });

  it("形如 content part 的对象同样被拒，不降级为 [object Object]，也不回显其文本", async () => {
    const { calls, res, activeChats } = await runCase(
      { type: "text", text: "fixture-object-text" },
      false,
      "fixture-561-B",
    );

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(res.body, /\[object Object\]/);
    assert.doesNotMatch(res.body, /fixture-object-text/);
    assert.equal(JSON.parse(res.body).error?.code, "invalid_content");
    assert.equal(activeChats.size, 0);
  });

  it("stream=true 时在 SSE 准入前拒绝（非 200 + SSE 帧）", async () => {
    const { calls, res, activeChats } = await runCase({ kind: "fixture-object", value: 7 }, true, "fixture-561-C");

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.doesNotMatch(res.body, /\[object Object\]/);
    assert.ok(!res.body.includes("data: [DONE]"));
    assert.equal(activeChats.size, 0);
  });

  it("流式模式下形如 content part 的对象也被拒", async () => {
    const { calls, res, activeChats } = await runCase(
      { type: "text", text: "fixture-object-text" },
      true,
      "fixture-561-D",
    );

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(res.body, /\[object Object\]/);
    assert.ok(!res.body.includes("data: [DONE]"));
    assert.equal(JSON.parse(res.body).error?.code, "invalid_content");
    assert.equal(activeChats.size, 0);
  });

  it("字符串 content 原样透传（错误分支不得吞掉正常路径）", async () => {
    const { calls, res, activeChats } = await runCase("hello fixture string", false, "fixture-561-E");

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.message, "hello fixture string");
    assert.equal(activeChats.size, 0);
  });

  it("数组 content 维持既有语义：字符串数组换行拼接，text part 取 text 字段", async () => {
    const stringArray = await runCase(["alpha", "beta"], false, "fixture-561-F1");
    assert.equal(stringArray.res.statusCode, 200);
    assert.equal(stringArray.calls[0]?.message, "alpha\nbeta");

    const partArray = await runCase(
      [
        { type: "text", text: "part-one" },
        { type: "input_text", text: "part-two" },
      ],
      false,
      "fixture-561-F2",
    );
    assert.equal(partArray.res.statusCode, 200);
    assert.equal(partArray.calls[0]?.message, "part-one\npart-two");
  });
});
