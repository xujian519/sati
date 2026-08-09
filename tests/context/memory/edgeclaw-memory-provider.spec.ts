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

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EdgeClawMemoryProvider retrieve 缓存", () => {
  const baseInput = {
    query: "同一问题",
    sessionId: "s1",
    projectRoot: "/tmp/p",
    recentMessages: [] as CanonicalMessage[],
  };

  it("同 session+query 二次 retrieve 命中 TTL 缓存，不重复调用底层", async () => {
    let calls = 0;
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => {
          calls += 1;
          return { systemContext: "记忆内容" };
        },
      }),
    });

    const first = await provider.retrieve(baseInput);
    const second = await provider.retrieve(baseInput);
    assert.equal(calls, 1);
    assert.equal(first.systemContext, "记忆内容");
    assert.equal(second.systemContext, "记忆内容");
  });

  it("不同 query / session / workspace 不共享缓存", async () => {
    let calls = 0;
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => {
          calls += 1;
          return { systemContext: `ctx-${calls}` };
        },
      }),
    });

    await provider.retrieve({ ...baseInput, query: "q1" });
    await provider.retrieve({ ...baseInput, query: "q2" });
    await provider.retrieve({ ...baseInput, sessionId: "s2" });
    await provider.retrieve({ ...baseInput, projectRoot: "/tmp/p2" });
    assert.equal(calls, 4);
  });

  it("TTL 过期后重新调用底层", async () => {
    let nowMs = 1_000;
    let calls = 0;
    const provider = new EdgeClawMemoryProvider({
      now: () => new Date(nowMs),
      retrieveCacheTtlMs: 100,
      service: makeService({
        retrieveContext: async () => {
          calls += 1;
          return { systemContext: "记忆内容" };
        },
      }),
    });

    await provider.retrieve(baseInput);
    nowMs += 50; // 未过期 → 命中
    await provider.retrieve(baseInput);
    assert.equal(calls, 1);

    nowMs += 100; // 已过期 → 重新检索
    await provider.retrieve(baseInput);
    assert.equal(calls, 2);
  });

  it("空结果也缓存，避免重复空检索", async () => {
    let calls = 0;
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => {
          calls += 1;
          return {};
        },
      }),
    });

    await provider.retrieve({ ...baseInput, query: "无结果" });
    await provider.retrieve({ ...baseInput, query: "无结果" });
    assert.equal(calls, 1);
  });

  it("失败结果不缓存，重试会再次调用底层", async () => {
    let calls = 0;
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return { systemContext: "恢复成功" };
        },
      }),
    });

    const failed = await provider.retrieve(baseInput);
    assert.equal(failed.diagnostics[0]?.code, "memory_provider_error");
    const recovered = await provider.retrieve(baseInput);
    assert.equal(recovered.systemContext, "恢复成功");
    assert.equal(calls, 2);
  });

  it("并发同 key retrieve 去重：底层只调用一次", async () => {
    const deferred = makeDeferred<{ systemContext: string }>();
    let calls = 0;
    const provider = new EdgeClawMemoryProvider({
      service: makeService({
        retrieveContext: async () => {
          calls += 1;
          return deferred.promise;
        },
      }),
    });

    const first = provider.retrieve(baseInput);
    const second = provider.retrieve(baseInput);
    deferred.resolve({ systemContext: "并发结果" });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(r1.systemContext, "并发结果");
    assert.equal(r2.systemContext, "并发结果");
  });
});
