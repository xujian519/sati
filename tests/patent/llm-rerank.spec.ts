import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../tool/context-fixture.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import {
  MAX_RERANK_CANDIDATES,
  MAX_SNIPPET_CHARS,
  rerankCandidatesWithModel,
  type RerankModelClient,
} from "../../src/patent/search/index.js";
import { createPatentCandidateRerankTool } from "../../src/tool/builtin/patentCandidateRerank.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

/**
 * P0-3 LLM 摘要精排：服务层（档位解析/降级/截断/修复重试）与
 * patent_candidate_rerank 工具层（注入 stub、topK、空候选、registry 注册）。
 */

function textDelta(text: string): CanonicalModelEvent {
  return { type: "text_delta", text } as CanonicalModelEvent;
}

/** 可编程 stub：按调用序返回响应；抛错项模拟模型调用失败。 */
function stubModel(responses: Array<string | Error>): { client: RerankModelClient; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    client: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        const prompt = request.messages[0]?.content?.[0]?.type === "text" ? request.messages[0].content[0].text : "";
        prompts.push(prompt);
        const response = responses[Math.min(call, responses.length - 1)];
        call += 1;
        if (response instanceof Error) throw response;
        yield textDelta(response);
      },
    },
  };
}

const candidates = [
  { id: "CN1001", title: "斜向滑轨变距机构", snippet: "导轨倾斜设置实现间距调节" },
  { id: "CN1002", title: "普通直线导轨", snippet: "平行导轨，无变距功能" },
  { id: "CN1003", title: "楔形导向机构", snippet: "楔面推动滑块改变间距" },
];

test("档位对象形态解析：按 tier 降序、保留理由、未评级候选置尾", async () => {
  const { client } = stubModel([
    JSON.stringify({
      results: [
        { id: "CN1002", tier: 1, reason: "方案不同" },
        { id: "CN1001", tier: 3, reason: "核心特征全部公开" },
        { id: "CN1003", tier: "2", reason: "原理等效" },
      ],
    }),
  ]);
  const result = await rerankCandidatesWithModel(client, "斜向导轨间距调节", candidates);
  assert.equal(result.degraded, false);
  assert.deepEqual(
    result.ranked.map(r => r.id),
    ["CN1001", "CN1003", "CN1002"],
  );
  assert.equal(result.ranked[0]!.tier, 3);
  assert.equal(result.ranked[1]!.tier, 2, "字符串 tier 应归一为数字");
  assert.equal(result.rerankedCount, 3);
});

test("裸数组与代码围栏形态可解析", async () => {
  const bare = stubModel([
    JSON.stringify([
      { id: "a", tier: 3 },
      { id: "b", tier: 0 },
    ]),
  ]);
  const r1 = await rerankCandidatesWithModel(bare.client, "q", [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  assert.equal(r1.degraded, false);
  assert.equal(r1.ranked[0]!.id, "a");

  const fenced = stubModel([
    "```json\n" +
      JSON.stringify({
        results: [
          { id: "a", tier: 2 },
          { id: "b", tier: 1 },
        ],
      }) +
      "\n```",
  ]);
  const r2 = await rerankCandidatesWithModel(fenced.client, "q", [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  assert.equal(r2.degraded, false);
  assert.equal(r2.ranked[0]!.tier, 2);
});

test("未知 id / 非法档位条目被忽略，未评级候选按原序置尾", async () => {
  const { client } = stubModel([
    JSON.stringify({
      results: [
        { id: "CN9999", tier: 3 },
        { id: "CN1002", tier: 9 },
        { id: "CN1003", tier: 2, reason: "等效" },
      ],
    }),
  ]);
  const result = await rerankCandidatesWithModel(client, "q", candidates);
  assert.equal(result.degraded, false);
  assert.equal(result.ranked[0]!.id, "CN1003");
  const ids = result.ranked.map(r => r.id);
  assert.deepEqual(ids, ["CN1003", "CN1001", "CN1002"], "未评级保持原序置尾，不外泄未知 id");
  assert.deepEqual(
    result.ranked.filter(r => r.tier === 0).map(r => r.id),
    ["CN1001", "CN1002"],
  );
});

test("解析失败 → 带 schema 修复重试成功（两次调用）", async () => {
  const good = JSON.stringify({ results: [{ id: "a", tier: 3 }] });
  const stub = stubModel(["这不是 JSON", good]);
  const result = await rerankCandidatesWithModel(stub.client, "q", [{ id: "a", title: "A" }]);
  assert.equal(result.degraded, false);
  assert.equal(stub.prompts.length, 2, "第二次应为修复重试请求");
  assert.match(stub.prompts[1]!, /上次输出无法解析为 JSON/);
});

test("修复重试仍失败 → 降级原序 degraded=true", async () => {
  const stub = stubModel(["garbage one", "garbage two", "garbage three"]);
  const result = await rerankCandidatesWithModel(stub.client, "q", candidates, { maxRepairRetries: 1 });
  assert.equal(result.degraded, true);
  assert.equal(result.rerankedCount, 0);
  assert.deepEqual(
    result.ranked.map(r => r.id),
    candidates.map(c => c.id),
    "降级保持原序",
  );
  assert.ok(result.ranked.every(r => r.tier === 0));
});

test("模型客户端缺失 / query 为空 / 空候选：各自降级或短路", async () => {
  const noClient = await rerankCandidatesWithModel(undefined, "q", candidates);
  assert.equal(noClient.degraded, true);
  assert.match(noClient.degradeReason ?? "", /模型客户端/);

  const { client } = stubModel(["{}"]);
  const emptyQuery = await rerankCandidatesWithModel(client, "  ", candidates);
  assert.equal(emptyQuery.degraded, true);
  assert.match(emptyQuery.degradeReason ?? "", /query 为空/);

  const noCands = await rerankCandidatesWithModel(client, "q", []);
  assert.equal(noCands.degraded, false);
  assert.equal(noCands.ranked.length, 0);
});

test("模型调用抛错 → 重试一次后降级", async () => {
  const stub = stubModel([new Error("provider 503")]);
  const result = await rerankCandidatesWithModel(stub.client, "q", candidates, { maxRepairRetries: 1 });
  assert.equal(result.degraded, true);
  assert.match(result.degradeReason ?? "", /503/);
  assert.equal(stub.prompts.length, 2, "抛错路径同样消耗一次重试");
});

test("候选超上限：前 20 条精排，其余原序附尾并计 truncatedCount", async () => {
  const many = Array.from({ length: MAX_RERANK_CANDIDATES + 5 }, (_, i) => ({
    id: `P${i}`,
    title: `Patent ${i}`,
  }));
  const ranks = { results: many.slice(0, MAX_RERANK_CANDIDATES).map(c => ({ id: c.id, tier: 1 })) };
  const { client } = stubModel([JSON.stringify(ranks)]);
  const result = await rerankCandidatesWithModel(client, "q", many);
  assert.equal(result.truncatedCount, 5);
  assert.equal(result.rerankedCount, MAX_RERANK_CANDIDATES);
  assert.equal(result.ranked.length, many.length, "被截断候选不静默丢弃");
  assert.deepEqual(
    result.ranked.slice(-5).map(r => r.id),
    many.slice(-5).map(c => c.id),
  );
  assert.ok(result.ranked.slice(-5).every(r => r.tier === 0));
});

test("摘要截断 ~400 字进入 prompt", async () => {
  const long = "超".repeat(MAX_SNIPPET_CHARS + 200);
  const stub = stubModel([JSON.stringify({ results: [{ id: "a", tier: 2 }] })]);
  await rerankCandidatesWithModel(stub.client, "q", [{ id: "a", title: "A", snippet: long }]);
  const sent = stub.prompts[0]!;
  assert.ok(sent.includes("超".repeat(MAX_SNIPPET_CHARS)));
  assert.ok(!sent.includes("超".repeat(MAX_SNIPPET_CHARS + 1)));
});

test("已取消的 signal 不再发起修复重试", async () => {
  const controller = new AbortController();
  const stub = stubModel(["garbage", JSON.stringify({ results: [{ id: "a", tier: 3 }] })]);
  controller.abort();
  const result = await rerankCandidatesWithModel(stub.client, "q", [{ id: "a", title: "A" }], {
    signal: controller.signal,
  });
  assert.equal(result.degraded, true);
  assert.equal(stub.prompts.length, 1, "abort 后不应二次调用");
});

// ---------------------------------------------------------------------------
// 工具层
// ---------------------------------------------------------------------------

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => (c.type === "text" && c.text ? c.text : "")).join("");
}

test("工具：注入 stub 精排 + topK 截断 + 文本档位标签", async () => {
  const { client } = stubModel([
    JSON.stringify({
      results: [
        { id: "CN1002", tier: 1, reason: "方案不同" },
        { id: "CN1001", tier: 3, reason: "核心特征公开" },
        { id: "CN1003", tier: 2 },
      ],
    }),
  ]);
  const tool = createPatentCandidateRerankTool({ model: client });
  const ctx = makeToolContext();
  const result = await tool.execute({ query: "斜向导轨间距调节", candidates, topK: 2 }, ctx);
  const text = textOf(result);
  assert.match(text, /\[高相关\] CN1001 — 核心特征公开/);
  assert.match(text, /\[中相关\] CN1003/);
  assert.equal(result.data?.ranked.length, 2);
  assert.equal(result.metadata?.degraded, false);
});

test("工具：候选为空短路返回", async () => {
  const tool = createPatentCandidateRerankTool();
  const result = await tool.execute({ query: "q", candidates: [] }, makeToolContext());
  assert.match(textOf(result), /candidates 为空/);
  assert.equal(result.data?.ranked.length, 0);
});

test("工具：context 无 model 时降级（degraded 透出到文本与 metadata）", async () => {
  const tool = createPatentCandidateRerankTool();
  const result = await tool.execute({ query: "q", candidates }, makeToolContext());
  assert.match(textOf(result), /精排降级/);
  assert.equal(result.metadata?.degraded, true);
  assert.equal(result.data?.ranked.length, candidates.length);
});

test("工具：继承 context.provider/modelId 到模型请求", async () => {
  const seen: Array<{ provider?: string; model?: string }> = [];
  const client: RerankModelClient = {
    async *stream(request: CanonicalModelRequest) {
      seen.push({ provider: request.provider, model: request.model });
      yield textDelta(JSON.stringify({ results: [{ id: "a", tier: 3 }] }));
    },
  };
  const tool = createPatentCandidateRerankTool({ model: client });
  const ctx = makeToolContext({ provider: "custom-provider", modelId: "custom-model" });
  await tool.execute({ query: "q", candidates: [{ id: "a", title: "A" }] }, ctx);
  assert.deepEqual(seen[0], { provider: "custom-provider", model: "custom-model" });
});

test("createBuiltinRegistry 注册 patent_candidate_rerank（domain: patent）", () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("patent_candidate_rerank");
  assert.ok(tool, "patent_candidate_rerank 应已注册");
  assert.equal(tool.domain, "patent");
});

test("工具为只读（不写盘、不改候选集合）：isReadOnly 为 true", () => {
  const tool = createPatentCandidateRerankTool();
  assert.equal(tool.isReadOnly({ query: "q", candidates: [] }), true);
});
