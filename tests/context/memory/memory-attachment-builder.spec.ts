import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import type {
  MemoryRetrieveInput,
  MemoryResolver,
  MemoryRetrieveResult,
} from "../../../src/context/memory/MemoryResolver.js";
import {
  MemoryAttachmentBuilder,
  buildRetrieveQuery,
  buildRetrieveTaskIntent,
} from "../../../src/context/memory/MemoryAttachmentBuilder.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

class RecordingResolver implements MemoryResolver {
  received: MemoryRetrieveInput[] = [];

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    this.received.push(input);
    return { diagnostics: [] };
  }

  async captureTurn(): Promise<void> {}
}

describe("buildRetrieveQuery", () => {
  it("长 query 原样返回，不做回退", () => {
    const query = "判断权利要求是否清楚完整";
    assert.equal(buildRetrieveQuery(query, [userMessage("历史问题")]), query);
  });

  it("短 query 用最近用户消息拼接", () => {
    const messages = [
      userMessage("第一个问题：什么是创造性"),
      assistantMessage("创造性的定义是……"),
      userMessage("那外观设计呢？"),
    ];
    const result = buildRetrieveQuery("继续", messages);
    assert.ok(result.includes("那外观设计呢？"), "最近的用户消息应在拼接结果中");
    assert.ok(result.includes("第一个问题：什么是创造性"), "更早的用户消息也应包含");
    assert.ok(!result.includes("创造性的定义是……"), "assistant 消息不应参与回退");
  });

  it("无可用用户历史时保持原 query", () => {
    assert.equal(buildRetrieveQuery("继续", []), "继续");
    assert.equal(buildRetrieveQuery("继续", [assistantMessage("只有助手消息")]), "继续");
  });

  it("回退拼接按消息顺序排列并截断到上限", () => {
    const longText = "长".repeat(800);
    const messages = [userMessage(longText), userMessage("第二个问题")];
    const result = buildRetrieveQuery("嗯", messages);
    assert.ok(result.length <= 500, "拼接结果应截断到 500 字");
    assert.ok(result.startsWith("长".repeat(500)), "截断应保留最早消息的前部");
  });

  it("最多拼接最近 3 条用户消息", () => {
    const messages = [userMessage("q1"), userMessage("q2"), userMessage("q3"), userMessage("q4"), userMessage("q5")];
    const result = buildRetrieveQuery("?", messages);
    assert.ok(result.includes("q5") && result.includes("q4") && result.includes("q3"));
    assert.ok(!result.includes("q2") && !result.includes("q1"), "更早的消息不应包含");
  });
});

describe("buildRetrieveTaskIntent", () => {
  it("OA 关键词命中 oa 意图", () => {
    assert.equal(buildRetrieveTaskIntent("帮我答复这份审查意见通知书"), "oa");
    assert.equal(buildRetrieveTaskIntent("审查员驳回理由分析"), "oa");
  });

  it("无效关键词命中 invalidity 意图", () => {
    assert.equal(buildRetrieveTaskIntent("分析这个专利能否无效"), "invalidity");
    assert.equal(buildRetrieveTaskIntent("无效宣告请求理由"), "invalidity");
  });

  it("撰写关键词命中 draft 意图", () => {
    assert.equal(buildRetrieveTaskIntent("撰写权利要求书"), "draft");
    assert.equal(buildRetrieveTaskIntent("技术交底书分析"), "draft");
  });

  it("普通 query 回退 general", () => {
    assert.equal(buildRetrieveTaskIntent("你好"), "general");
    assert.equal(buildRetrieveTaskIntent(""), "general");
    assert.equal(buildRetrieveTaskIntent("  "), "general");
  });

  it("短 query 在 builder 内经回退 query 推导意图", async () => {
    const resolver = new RecordingResolver();
    const builder = new MemoryAttachmentBuilder(resolver);
    await builder.build({
      query: "继续",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages: [userMessage("请帮我答复这份审查意见：创造性 A22.3")],
    });
    assert.equal(resolver.received[0]?.taskIntent, "oa", "短 query 应按回退 query 推导意图");
  });

  it("调用方显式传入 taskIntent 时透传不改写", async () => {
    const resolver = new RecordingResolver();
    const builder = new MemoryAttachmentBuilder(resolver);
    await builder.build({
      query: "你好",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages: [],
      taskIntent: "draft",
    });
    assert.equal(resolver.received[0]?.taskIntent, "draft");
  });
});

describe("MemoryAttachmentBuilder", () => {
  it("短 query 时传给 resolver 的 query 为回退值，其余字段不变", async () => {
    const resolver = new RecordingResolver();
    const builder = new MemoryAttachmentBuilder(resolver);
    const recentMessages = [userMessage("什么是创造性判断的三步法")];

    await builder.build({
      query: "继续",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages,
      timeoutMs: 5000,
    });

    assert.equal(resolver.received.length, 1);
    const input = resolver.received[0];
    assert.ok(input.query.includes("什么是创造性判断的三步法"), "应使用回退 query");
    assert.equal(input.sessionId, "s1");
    assert.equal(input.projectRoot, "/tmp");
    // resolver 收到的是 builder 内部 controller.signal（合并外部 abort 与超时）
    assert.ok(input.signal, "应传入 signal");
  });

  it("长 query 透传原值", async () => {
    const resolver = new RecordingResolver();
    const builder = new MemoryAttachmentBuilder(resolver);
    const query = "判断权利要求是否清楚完整";
    await builder.build({ query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] });
    assert.equal(resolver.received[0]?.query, query);
  });

  it("resolver 返回 systemContext 时包装为 memory-context 附件", async () => {
    const resolver: MemoryResolver = {
      async retrieve(): Promise<MemoryRetrieveResult> {
        return { systemContext: "<knowledge-graph>…</knowledge-graph>", diagnostics: [] };
      },
      async captureTurn(): Promise<void> {},
    };
    const builder = new MemoryAttachmentBuilder(resolver);
    const result = await builder.build({ query: "q", sessionId: "s1", projectRoot: "/tmp", recentMessages: [] });
    assert.equal(result.attachments.length, 1);
    const text = result.attachments[0]?.content[0];
    assert.equal(text?.type, "text");
    assert.ok(text?.type === "text" && text.text.includes("<memory-context>"));
  });
});

describe("MemoryAttachmentBuilder 超时 / 中止熔断（#536）", () => {
  /** 永不结算的 resolver：模拟内层 memory-gate LLM 卡住（vendored 子包不消费 signal）。 */
  function hangingResolver(): MemoryResolver {
    return {
      async retrieve(): Promise<MemoryRetrieveResult> {
        return await new Promise<MemoryRetrieveResult>(() => {});
      },
      async captureTurn(): Promise<void> {},
    };
  }

  it("超时熔断：fake timer 推进到 timeoutMs → 空注入、不抛、诊断 memory_provider_error", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const builder = new MemoryAttachmentBuilder(hangingResolver());
    const pending = builder.build({
      query: "q",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages: [],
      timeoutMs: 30_000,
    });
    // 负控制锚点：若撤掉 build() 内的「超时即空注入」分支，pending 永不结算、本用例会挂起失败。
    t.mock.timers.tick(30_000);
    const result = await pending;
    assert.equal(result.attachments.length, 0, "超时应空注入");
    assert.equal(result.diagnostics[0]?.code, "memory_provider_error");
    assert.equal(result.diagnostics[0]?.severity, "warning");
    assert.match(result.diagnostics[0]?.message ?? "", /timed out after 30000ms/);
  });

  it("外部 abortSignal 取消：空注入、无诊断、不抛（区别于超时降级）", async () => {
    const controller = new AbortController();
    const builder = new MemoryAttachmentBuilder(hangingResolver());
    const pending = builder.build({
      query: "q",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages: [],
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.attachments.length, 0);
    assert.deepEqual(result.diagnostics, [], "回合级取消是预期路径，不应记 warning 诊断");
  });
});
