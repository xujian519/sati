import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import type {
  MemoryRetrieveInput,
  MemoryResolver,
  MemoryRetrieveResult,
} from "../../../src/context/memory/MemoryResolver.js";
import { MemoryAttachmentBuilder, buildRetrieveQuery } from "../../../src/context/memory/MemoryAttachmentBuilder.js";

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
