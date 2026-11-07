import assert from "node:assert/strict";
import test from "node:test";
import { SearchRecallHandler, type SearchRecallResult } from "../../../src/patent/atoms/handlers/builtin/search.js";
import type { StageProvider } from "../../../src/patent/atoms/index.js";

function docsFor(query: string): Array<{ title: string; snippet: string; url: string }> {
  return [{ title: `文献 ${query}`, snippet: "摘要", url: `https://example.com/${encodeURIComponent(query)}` }];
}

function recall(adequate: boolean, missing: string[] = []): string {
  return JSON.stringify({ adequate, covered_features: adequate ? ["壳体"] : [], missing_features: missing });
}

test("searchRecallAtom: 首轮覆盖时只检索一次", async () => {
  let searches = 0;
  let llmCalls = 0;
  const provider: StageProvider = {
    search: async query => {
      searches += 1;
      return docsFor(query);
    },
    callLLM: async () => {
      llmCalls += 1;
      return recall(true);
    },
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体"] },
    provider,
  });
  assert.equal(searches, 1);
  assert.equal(llmCalls, 1);
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "adequate");
  assert.equal(result.rounds, 0);
});

test("searchRecallAtom: 首轮不足时补检，第二轮覆盖则 adequate", async () => {
  let searches = 0;
  const provider: StageProvider = {
    search: async query => {
      searches += 1;
      return docsFor(query);
    },
    callLLM: async () => (searches === 1 ? recall(false, ["滤芯"]) : recall(true)),
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体", "滤芯"] },
    provider,
  });
  assert.equal(searches, 2);
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "adequate");
  assert.equal(result.rounds, 1);
});

test("searchRecallAtom: 轮次用尽仍缺则标记 uncovered 并列出特征", async () => {
  let searches = 0;
  const provider: StageProvider = {
    search: async query => {
      searches += 1;
      return docsFor(query);
    },
    callLLM: async () => recall(false, ["滤芯"]),
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体", "滤芯"], retrieval_rounds: 2 },
    provider,
  });
  assert.equal(searches, 3);
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "uncovered");
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.missingFeatures, ["滤芯"]);
  assert.ok(String(state.search_summary).includes("滤芯"));
});

test("searchRecallAtom: retrieval_rounds 为数字 0 时仍检索一次且不补检", async () => {
  let searches = 0;
  let llmCalls = 0;
  const provider: StageProvider = {
    search: async query => {
      searches += 1;
      return docsFor(query);
    },
    callLLM: async () => {
      llmCalls += 1;
      return recall(false, ["滤芯"]);
    },
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体"], retrieval_rounds: 0 },
    provider,
  });
  assert.equal(searches, 1);
  assert.equal(llmCalls, 0);
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "single_pass");
});

test("searchRecallAtom: 召回模型失败记 not_evaluated，不当作已覆盖", async () => {
  const provider: StageProvider = {
    search: async query => docsFor(query),
    callLLM: async () => {
      throw new Error("模型超时");
    },
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体"] },
    provider,
  });
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "not_evaluated");
});

test("searchRecallAtom: 无特征清单时仍检索一次并记 not_evaluated", async () => {
  let searches = 0;
  const provider: StageProvider = {
    search: async query => {
      searches += 1;
      return docsFor(query);
    },
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体" },
    provider,
  });
  assert.equal(searches, 1);
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "not_evaluated");
  assert.ok(String(state.search_summary).includes("无特征清单"));
});

test("searchRecallAtom: 补检结果按 url 去重", async () => {
  const provider: StageProvider = {
    search: async () => [{ title: "同一篇", snippet: "摘要", url: "https://example.com/same" }],
    callLLM: async () => recall(false, ["滤芯"]),
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体"], retrieval_rounds: 1 },
    provider,
  });
  assert.equal((state.prior_art as unknown[]).length, 1);
});

test("searchRecallAtom: 未配置检索器时主输出写明原因", async () => {
  const state = await new SearchRecallHandler().execute({ state: { query: "壳体", features: ["壳体"] } });
  assert.ok(String(state.search_summary).includes("未配置检索器"));
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "not_evaluated");
});

test("searchRecallAtom: 补检轮检索失败保留首轮结果并记未评估", async () => {
  let searches = 0;
  const provider: StageProvider = {
    search: async () => {
      searches += 1;
      if (searches === 1) return docsFor("壳体");
      throw new Error("网络中断");
    },
    callLLM: async () => recall(false, ["滤芯"]),
  };
  const state = await new SearchRecallHandler().execute({
    state: { query: "壳体", features: ["壳体", "滤芯"], retrieval_rounds: 1 },
    provider,
  });
  assert.equal((state.prior_art as unknown[]).length, 1, "首轮证据不得因补检失败丢失");
  assert.ok(String(state.search_summary).includes("补检第 1 轮检索失败"));
  const result = JSON.parse(state.search_recall as string) as SearchRecallResult;
  assert.equal(result.status, "not_evaluated");
  assert.equal(result.rounds, 0);
  assert.ok(result.reason?.includes("补检第 1 轮检索失败"));
});
