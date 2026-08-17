import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import {
  createMemoryDreamTool,
  createMemoryFlushTool,
  createMemoryGetTool,
  createMemoryListTool,
  createMemoryOverviewTool,
  createMemorySearchTool,
} from "../../src/tool/builtin/memoryTools.js";
import { SatiToolRuntimeError } from "../../src/tool/protocol/errors.js";
import type { SatiToolDefinition } from "../../src/tool/protocol/types.js";
import { makeToolContext } from "./context-fixture.js";

type ServiceCalls = {
  overview: number;
  list: unknown[];
  search: unknown[];
  get: unknown[];
  flush: unknown[];
  dream: unknown[];
};

/** 对象字面量 stub：记录调用参数，返回可识别的固定值。 */
function makeStubService(overrides: Partial<Record<string, unknown>> = {}): {
  service: EdgeClawMemoryService;
  calls: ServiceCalls;
} {
  const calls: ServiceCalls = { overview: 0, list: [], search: [], get: [], flush: [], dream: [] };
  const service = {
    overview: () => {
      calls.overview += 1;
      return { status: "ok", pendingSessions: 2 };
    },
    list: (options: unknown) => {
      calls.list.push(options);
      return [{ id: "user/pref.md", name: "pref" }];
    },
    search: async (query: string, options: unknown) => {
      calls.search.push([query, options]);
      return { context: "召回内容", trace: { steps: [] } };
    },
    get: (ids: string[], maxLines?: number) => {
      calls.get.push([ids, maxLines]);
      return ids.map(id => ({ id, content: `内容:${id}` }));
    },
    flush: async (options: unknown) => {
      calls.flush.push(options);
      return { scannedSessions: 1, writtenFiles: 1 };
    },
    dream: async (trigger: unknown) => {
      calls.dream.push(trigger);
      return { isNoOp: false, merged: 1 };
    },
    ...overrides,
  } as unknown as EdgeClawMemoryService;
  return { service, calls };
}

describe("memory_* builtin tools", () => {
  it("memory_overview 返回 service.overview() 的 JSON 包装", async () => {
    const { service, calls } = makeStubService();
    const tool = createMemoryOverviewTool(service);

    const result = await tool.execute({}, makeToolContext());

    assert.equal(calls.overview, 1);
    assert.deepEqual(result.data, { status: "ok", pendingSessions: 2 });
    assert.deepEqual(result.content, [{ type: "json", value: { status: "ok", pendingSessions: 2 } }]);
  });

  it("memory_list 透传 kinds/query/limit/scope", async () => {
    const { service, calls } = makeStubService();
    const tool = createMemoryListTool(service);

    const result = await tool.execute(
      { kinds: ["user", "project"], query: "偏好", limit: 10, scope: "project" },
      makeToolContext(),
    );

    assert.deepEqual(calls.list, [{ kinds: ["user", "project"], query: "偏好", limit: 10, scope: "project" }]);
    assert.deepEqual(result.data, [{ id: "user/pref.md", name: "pref" }]);
  });

  it("memory_search 透传 query", async () => {
    const { service, calls } = makeStubService();
    const tool = createMemorySearchTool(service);

    const result = await tool.execute({ query: "上次的结论" }, makeToolContext());

    assert.deepEqual(calls.search, [["上次的结论", undefined]]);
    assert.deepEqual(result.data, { context: "召回内容", trace: { steps: [] } });
  });

  it("memory_get 透传 ids 与 maxLines", async () => {
    const { service, calls } = makeStubService();
    const tool = createMemoryGetTool(service);

    const result = await tool.execute({ ids: ["a.md", "b.md"], maxLines: 20 }, makeToolContext());

    assert.deepEqual(calls.get, [[["a.md", "b.md"], 20]]);
    assert.deepEqual(result.data, [
      { id: "a.md", content: "内容:a.md" },
      { id: "b.md", content: "内容:b.md" },
    ]);
  });

  it("memory_flush 以 manual reason 调用并透传 batchSize", async () => {
    const { service, calls } = makeStubService();
    const tool = createMemoryFlushTool(service);

    const result = await tool.execute({ batchSize: 5 }, makeToolContext());

    assert.deepEqual(calls.flush, [{ reason: "manual", batchSize: 5 }]);
    assert.deepEqual(result.data, { scannedSessions: 1, writtenFiles: 1 });
  });

  it("memory_dream 以 manual trigger 调用", async () => {
    const { service, calls } = makeStubService();
    const tool = createMemoryDreamTool(service);

    const result = await tool.execute({}, makeToolContext());

    assert.deepEqual(calls.dream, ["manual"]);
    assert.deepEqual(result.data, { isNoOp: false, merged: 1 });
  });

  it("只读标记：overview/list/search/get 只读且并发安全，flush/dream 非只读", () => {
    const { service } = makeStubService();

    for (const tool of [
      createMemoryOverviewTool(service),
      createMemoryListTool(service),
      createMemorySearchTool(service),
      createMemoryGetTool(service),
    ]) {
      // isReadOnly/isConcurrencySafe 不消费 input（只返回工具定义常量），
      // 用空 input 类型探针调用；工具断言为 Record<string, never> input 形态。
      const probe = tool as unknown as SatiToolDefinition<Record<string, never>, unknown>;
      assert.equal(probe.isReadOnly({}), true, `${tool.name} should be read-only`);
      assert.equal(probe.isConcurrencySafe({}), true, `${tool.name} should be concurrency-safe`);
    }
    for (const tool of [createMemoryFlushTool(service), createMemoryDreamTool(service)]) {
      const probe = tool as unknown as SatiToolDefinition<Record<string, never>, unknown>;
      assert.equal(probe.isReadOnly({}), false, `${tool.name} should not be read-only`);
    }
  });

  it("service 抛错时工具以 SatiToolRuntimeError 失败而非崩溃", async () => {
    const { service } = makeStubService({
      overview: () => {
        throw new Error("sqlite locked");
      },
      search: async () => {
        throw new Error("retriever boom");
      },
    });

    await assert.rejects(createMemoryOverviewTool(service).execute({}, makeToolContext()), error => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "tool_execution_failed");
      assert.match(error.message, /memory_overview failed: sqlite locked/);
      return true;
    });
    await assert.rejects(createMemorySearchTool(service).execute({ query: "x" }, makeToolContext()), error => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "tool_execution_failed");
      assert.match(error.message, /memory_search failed: retriever boom/);
      return true;
    });
  });
});
