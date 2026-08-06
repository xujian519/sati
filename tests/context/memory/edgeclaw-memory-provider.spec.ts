import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EdgeClawMemoryProvider,
  type EdgeClawMemoryServiceLike,
} from "../../../src/context/memory/EdgeClawMemoryProvider.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] } as CanonicalMessage;
}

function makeService(overrides: Partial<EdgeClawMemoryServiceLike>): EdgeClawMemoryServiceLike {
  return {
    retrieveContext: async () => ({}),
    captureTurn: () => ({ captured: true, normalizedMessages: [], sessionKey: "s1" }),
    ...overrides,
  };
}

describe("EdgeClawMemoryProvider", () => {
  it("retrieve 成功：包装 systemContext 并透传 trace/debug", async () => {
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => ({
          systemContext: "记忆上下文内容",
          trace: { steps: [] },
          debug: { route: "project" },
        }),
      }),
    });

    const result = await provider.retrieve({
      query: "之前定的存储方案",
      sessionId: "s1",
      projectRoot: "/tmp/project",
      recentMessages: [userMessage("之前定的存储方案")],
    });

    assert.equal(result.systemContext, "记忆上下文内容");
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.metadata?.debug, { route: "project" });
  });

  it("retrieve 空结果：返回 memory_context_empty 诊断", async () => {
    const provider = new EdgeClawMemoryProvider({
      service: makeService({ retrieveContext: async () => ({ context: "  " }) }),
    });

    const result = await provider.retrieve({
      query: "无关问题",
      sessionId: "s1",
      projectRoot: "/tmp/project",
      recentMessages: [],
    });

    assert.equal(result.systemContext, undefined);
    assert.equal(result.diagnostics[0]?.code, "memory_context_empty");
    assert.equal(result.diagnostics[0]?.severity, "info");
  });

  it("retrieve 失败降级：返回 memory_provider_error 诊断而不抛出", async () => {
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => {
          throw new Error("memory service down");
        },
      }),
    });

    const result = await provider.retrieve({
      query: "任意查询",
      sessionId: "s1",
      projectRoot: "/tmp/project",
      recentMessages: [],
    });

    assert.equal(result.systemContext, undefined);
    assert.equal(result.diagnostics[0]?.code, "memory_provider_error");
    assert.equal(result.diagnostics[0]?.severity, "error");
    assert.equal(result.diagnostics[0]?.message, "memory service down");
  });

  it("captureTurn 失败静默不抛，且不影响后续调用", async () => {
    let captureCalls = 0;
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        captureTurn: () => {
          captureCalls += 1;
          throw new Error("disk full");
        },
      }),
    });

    // 不应抛出
    await provider.captureTurn({
      sessionId: "s1",
      projectRoot: "/tmp/project",
      messages: [userMessage("你好")],
      errored: false,
    });
    await provider.captureTurn({
      sessionId: "s1",
      projectRoot: "/tmp/project",
      messages: [userMessage("第二条")],
      errored: false,
    });
    assert.equal(captureCalls, 2);
  });
});
