/**
 * 附图检索（retrieve）单元测试：关键词/向量/混合/降级路径。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFigureDocumentText,
  MAX_VECTOR_DOCS,
  retrieveFigures,
  tokenizeFigureText,
} from "../../../src/patent/figure/retrieve.js";
import type { FigureIndexEntry } from "../../../src/patent/figure/index-store.js";
import type { EmbeddingClient } from "../../../src/model/embedding/index.js";
import type { FigureAnalysisResult } from "../../../src/patent/figure/types.js";

function makeEntry(imagePath: string, figureNumber: number, componentNames: string[]): FigureIndexEntry {
  const analysis: FigureAnalysisResult = {
    imagePath,
    figureNumber,
    figureType: "structure",
    overallDescription: componentNames.join("、") + "组成的结构",
    components: componentNames.map((name, index) => ({
      refNumber: String(index + 1),
      name,
      kind: "mechanical",
      description: `${name}部件`,
    })),
    connections: [],
    figureDescription: `图${figureNumber}是结构示意图；图中：${componentNames.map((n, i) => `${i + 1}-${n}`).join("；")}；`,
    confidence: 0.9,
    warnings: [],
    usable: true,
    modelUsed: "moonshot/kimi-k3",
  };
  return { imagePath, analyzedAt: "2026-08-06T00:00:00.000Z", analysis };
}

/** 脚本化 embedding 客户端：按调用顺序依次吐出预设向量。 */
function scriptedEmbedding(vectors: number[][]): EmbeddingClient {
  let cursor = 0;
  return {
    dimensions: 4,
    healthCheck: async () => true,
    async embed(texts: string[]): Promise<number[][]> {
      const out = vectors.slice(cursor, cursor + texts.length);
      cursor += texts.length;
      return out;
    },
  };
}

test("retrieve: 分词——CJK 单字+二元组 + ASCII 词元", () => {
  const tokens = tokenizeFigureText("缓冲层 图1 bge");
  assert.ok(tokens.includes("缓冲"));
  assert.ok(tokens.includes("缓冲层") === false, "只产单字与二元组，不产三元组");
  assert.ok(tokens.includes("层"));
  // 汉字与数字不组二元组：图 + 1 分别成词元
  assert.ok(tokens.includes("图"));
  assert.ok(tokens.includes("1"));
  assert.ok(tokens.includes("图1") === false);
  assert.ok(tokens.includes("bge"));
});

test("retrieve: 图档文本含编号/类型/组件/附图说明/文件名", () => {
  const text = buildFigureDocumentText(makeEntry("figures/图1.png", 1, ["缓冲层"]));
  assert.ok(text.includes("图1"));
  assert.ok(text.includes("结构示意图"));
  assert.ok(text.includes("缓冲层"));
  assert.ok(text.includes("1-缓冲层"));
  assert.ok(text.includes("图1.png"));
});

test("retrieve: 关键词命中组件名并排序（零分条目被过滤）", async () => {
  const entries = [
    makeEntry("figures/图2.png", 2, ["壳体"]),
    makeEntry("figures/图1.png", 1, ["缓冲层"]),
    makeEntry("figures/图3.png", 3, ["绝缘层"]),
  ];
  const { hits, method } = await retrieveFigures(entries, "缓冲层", { limit: 3 });
  assert.equal(method, "keyword");
  // 图2 壳体与查询无任何词元重叠 → 零分被过滤
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.entry.analysis.figureNumber, 1);
  assert.ok((hits[0]?.score ?? 0) > 0);
  // 图3 绝缘层仅共享单字"层" → 低分但非零
  assert.equal(hits[1]?.entry.analysis.figureNumber, 3);
  assert.ok((hits[1]?.score ?? 0) > 0);
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
});

test("retrieve: 空查询 → 列表模式（按附图编号排序，usable 得分 1）", async () => {
  const entries = [makeEntry("figures/图2.png", 2, ["壳体"]), makeEntry("figures/图1.png", 1, ["缓冲层"])];
  const { hits, method } = await retrieveFigures(entries, "   ", { limit: 5 });
  assert.equal(method, "keyword");
  assert.deepEqual(
    hits.map(hit => hit.entry.analysis.figureNumber),
    [1, 2],
  );
  assert.equal(hits[0]?.score, 1);
});

test("retrieve: limit 截断", async () => {
  const entries = Array.from({ length: 5 }, (_, index) => makeEntry(`figures/图${index + 1}.png`, index + 1, ["壳体"]));
  const { hits } = await retrieveFigures(entries, "壳体", { limit: 2 });
  assert.equal(hits.length, 2);
});

test("retrieve: 混合检索——关键词有命中时加权融合（0.6 关键词 + 0.4 向量）", async () => {
  const entries = [makeEntry("figures/图1.png", 1, ["散热鳍片"]), makeEntry("figures/图2.png", 2, ["外壳"])];
  // query + 2 docs → 预设单位向量：图1 与 query 余弦 0.8，图2 余弦 0.2
  const embedding = scriptedEmbedding([
    [1, 0, 0, 0],
    [0.8, 0.6, 0, 0],
    [0.2, 0.98, 0, 0],
  ]);
  const { hits, method } = await retrieveFigures(entries, "散热", { limit: 2, embeddingClient: embedding });
  assert.equal(method, "hybrid");
  assert.equal(hits[0]?.entry.analysis.figureNumber, 1);
  // 图1 混合分 = 0.6 * 关键词分 + 0.4 * 0.8
  const keywordOnly = await retrieveFigures(entries, "散热", { limit: 2 });
  const keywordScore = keywordOnly.hits.find(hit => hit.entry.analysis.figureNumber === 1)?.score ?? 0;
  const expected = 0.6 * keywordScore + 0.4 * 0.8;
  assert.ok(Math.abs((hits[0]?.score ?? 0) - expected) < 1e-6);
});

test("retrieve: 关键词零命中 → 纯向量检索", async () => {
  const entries = [makeEntry("figures/图1.png", 1, ["外壳"]), makeEntry("figures/图2.png", 2, ["密封圈"])];
  const embedding = scriptedEmbedding([
    [1, 0, 0, 0],
    [0.8, 0.6, 0, 0],
    [0.6, 0.8, 0, 0],
  ]);
  const { hits, method, note } = await retrieveFigures(entries, "散热鳍片", { limit: 2, embeddingClient: embedding });
  assert.equal(method, "vector");
  assert.equal(hits[0]?.entry.analysis.figureNumber, 1);
  assert.ok(Math.abs((hits[0]?.score ?? 0) - 0.8) < 1e-6);
  assert.ok(note?.includes("向量"), "应说明按向量返回");
});

test("retrieve: embedding 抛错 → 降级关键词检索", async () => {
  const entries = [makeEntry("figures/图1.png", 1, ["缓冲层"])];
  const failing: EmbeddingClient = {
    dimensions: 4,
    healthCheck: async () => true,
    async embed() {
      throw new Error("embedding endpoint down");
    },
  };
  const { hits, method } = await retrieveFigures(entries, "缓冲层", { limit: 2, embeddingClient: failing });
  assert.equal(method, "keyword");
  assert.equal(hits.length, 1);
});

test("retrieve: 索引超过向量上限 → 仅关键词 + note", async () => {
  const entries = Array.from({ length: MAX_VECTOR_DOCS + 1 }, (_, index) =>
    makeEntry(`figures/图${index + 1}.png`, index + 1, index === 0 ? ["散热片"] : ["壳体"]),
  );
  const embedding = scriptedEmbedding([]);
  const { hits, method, note } = await retrieveFigures(entries, "散热片", { limit: 3, embeddingClient: embedding });
  assert.equal(method, "keyword");
  assert.equal(hits[0]?.entry.analysis.figureNumber, 1);
  assert.ok(note?.includes("上限"), "应说明仅关键词检索原因");
});

test("retrieve: 空条目 → 空结果", async () => {
  const { hits, method } = await retrieveFigures([], "散热", { limit: 5 });
  assert.equal(method, "keyword");
  assert.deepEqual(hits, []);
});

test("retrieve: 全符号查询 → 列表模式", async () => {
  const entries = [makeEntry("figures/图2.png", 2, ["壳体"]), makeEntry("figures/图1.png", 1, ["缓冲层"])];
  const { hits, method } = await retrieveFigures(entries, "!!!", { limit: 5 });
  assert.equal(method, "keyword");
  assert.deepEqual(
    hits.map(hit => hit.entry.analysis.figureNumber),
    [1, 2],
  );
});

test("retrieve: 纯向量路保留全部条目（不滤零分）", async () => {
  const entries = [makeEntry("figures/图1.png", 1, ["外壳"]), makeEntry("figures/图2.png", 2, ["密封圈"])];
  const embedding = scriptedEmbedding([
    [1, 0, 0, 0],
    [0.8, 0.6, 0, 0],
    [0, 1, 0, 0],
  ]);
  const { hits, method } = await retrieveFigures(entries, "散热鳍片", { limit: 2, embeddingClient: embedding });
  assert.equal(method, "vector");
  assert.equal(hits.length, 2, "向量路不滤零分条目");
  assert.equal(hits[0]?.entry.analysis.figureNumber, 1);
  assert.equal(hits[1]?.score, 0, "零分条目保留在结果尾部");
});

test("retrieve: 畸形条目（缺 components）不崩溃", async () => {
  const entry = makeEntry("figures/图1.png", 1, ["壳体"]);
  const malformed = {
    ...entry,
    analysis: { ...entry.analysis, components: undefined },
  } as unknown as FigureIndexEntry;
  // 图档文本构建不抛裸 TypeError
  const text = buildFigureDocumentText(malformed);
  assert.ok(typeof text === "string");
  // 检索入口也不崩溃（组件缺失由兜底处理；附图说明文字仍可命中）
  const { hits } = await retrieveFigures([malformed], "壳体", { limit: 5 });
  assert.equal(hits.length, 1);
  assert.ok((hits[0]?.score ?? 0) > 0);
});

test("retrieve: embedding 返回空数组 → 降级关键词", async () => {
  const entries = [makeEntry("figures/图1.png", 1, ["缓冲层"])];
  const empty: EmbeddingClient = {
    dimensions: 4,
    healthCheck: async () => true,
    async embed(): Promise<number[][]> {
      return [];
    },
  };
  const { hits, method } = await retrieveFigures(entries, "缓冲层", { limit: 2, embeddingClient: empty });
  assert.equal(method, "keyword");
  assert.equal(hits[0]?.entry.analysis.figureNumber, 1);
});
