import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import type { WikiCardLoader, WikiCardMeta } from "../../src/knowledge/patent/wiki-card-loader.js";
import { WikiCardVectorIndex } from "../../src/knowledge/patent/wiki-card-vector-index.js";

/**
 * WikiCardVectorIndex 测试（此前零直接测试）。
 * fake embedding 用字符 2-gram 特征向量：文本与查询共享 2-gram 越多余弦越高，
 * 可可靠验证 top-k 排序。增量同步按快照（id/title/concept/domain）门控。
 */

function charNgramVector(text: string, dim = 64): number[] {
  const vec = new Array<number>(dim).fill(0);
  const chars = Array.from(text);
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = chars[i]! + chars[i + 1]!;
    let h = 0;
    for (const ch of gram) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
    vec[h % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

function fakeEmbedding(): EmbeddingClient {
  return {
    dimensions: 64,
    healthCheck: async () => true,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => charNgramVector(text));
    },
  };
}

type MockCard = { id: string; title: string; concept?: string; domain?: string; body: string };

/** 可变 mock loader：可在测试中途改卡片集，验证快照门控增量同步。 */
function mockLoader(cards: MockCard[]): { loader: WikiCardLoader; setCards: (next: MockCard[]) => void } {
  let current = [...cards];
  const metaOf = (c: MockCard): WikiCardMeta => ({
    id: c.id,
    title: c.title,
    concept: c.concept,
    domain: c.domain,
    relativePath: `${c.id}.md`,
  });
  const loader = {
    list: (_limit: number): WikiCardMeta[] => current.map(metaOf),
    getById: (id: string): WikiCardMeta | undefined => {
      const card = current.find(c => c.id === id);
      return card ? metaOf(card) : undefined;
    },
    formatAsContext: (id: string, maxChars: number): string => {
      const card = current.find(c => c.id === id);
      return card ? card.body.slice(0, maxChars) : "";
    },
  } as unknown as WikiCardLoader;
  return {
    loader,
    setCards: next => {
      current = [...next];
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wiki-vec-test-"));
}

test("warmup 构建索引，search 返回 top-k 命中（与查询共享 2-gram 最多者居首）", async () => {
  const dir = tempDir();
  const { loader } = mockLoader([
    { id: "c1", title: "创造性三步法", concept: "创造性", body: "第一步确定最接近的现有技术。" },
    { id: "c2", title: "新颖性", concept: "新颖性", body: "单独对比原则。" },
    { id: "c3", title: "说明书充分公开", concept: "说明书", body: "能够实现的技术方案。" },
  ]);
  const index = new WikiCardVectorIndex({ loader, client: fakeEmbedding(), storePath: join(dir, "wiki.jsonl") });
  try {
    await index.warmup();
    assert.equal(index.size, 3, "应索引全部 3 张卡片");
    // 查询文本与 c1 的 title/正文共享最多 2-gram
    const hits = await index.search("创造性三步法", 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0]!.id, "c1", `应命中 c1: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("就绪才检索：未 warmup 时 search 返回空（不阻塞），warmup 后正常检索", async () => {
  const dir = tempDir();
  const { loader } = mockLoader([{ id: "c1", title: "创造性三步法", body: "最接近的现有技术。" }]);
  const index = new WikiCardVectorIndex({ loader, client: fakeEmbedding(), storePath: join(dir, "wiki.jsonl") });
  try {
    // 语义是可选增强：warmup 未完成（首次全量 embed 可能数十秒）时直接返回空，
    // 绝不阻塞主流程（此前行为是 await 全量 warmup，见 perf 探针 115s）。
    assert.deepEqual(await index.search("创造性三步法", 1), []);
    // 显式 warmup 完成后正常 top-k 检索
    await index.warmup();
    const hits = await index.search("创造性三步法", 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.id, "c1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("语料静态语义：loader 一次快照，warmup 幂等（后续 search 不再全量重建）", async () => {
  const dir = tempDir();
  const { loader } = mockLoader([
    { id: "c1", title: "创造性三步法", body: "第一步确定最接近的现有技术。" },
    { id: "c2", title: "新颖性", body: "单独对比原则。" },
  ]);
  const index = new WikiCardVectorIndex({ loader, client: fakeEmbedding(), storePath: join(dir, "wiki.jsonl") });
  try {
    await index.warmup();
    assert.equal(index.size, 2);
    // warmup 幂等：第二次调用不重复全量同步；检索继续命中（索引保持）
    await index.warmup();
    const hits = await index.search("创造性三步法", 2);
    assert.ok(hits.length > 0);
    assert.equal(index.size, 2);
    // loader 为一次性快照：卡片集运行时不变（见 wiki-card-loader ensureLoaded），
    // 变更需重建 loader + index 实例（由提供方负责，索引侧不追踪）。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空语料：search 返回空数组不抛错", async () => {
  const dir = tempDir();
  const { loader } = mockLoader([]);
  const index = new WikiCardVectorIndex({ loader, client: fakeEmbedding(), storePath: join(dir, "wiki.jsonl") });
  try {
    await index.warmup();
    assert.equal(index.size, 0);
    assert.deepEqual(await index.search("任何查询", 3), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
