import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EmbeddingClient } from "../../../src/model/embedding/types.js";
import { VectorIndex } from "../../../src/context/vector/vector-index.js";

/**
 * 确定性 stub embedding client：字符码求和的确定性向量，
 * 共享字符越多的文本向量越接近（足以断言排序/增量行为）。
 */
function makeStubEmbeddingClient(dims = 8): { client: EmbeddingClient; embedCalls: string[][] } {
  const embedCalls: string[][] = [];
  const client: EmbeddingClient = {
    dimensions: dims,
    async embed(texts: string[]): Promise<number[][]> {
      embedCalls.push([...texts]);
      return texts.map(text => {
        const vector = new Array<number>(dims).fill(0);
        for (let i = 0; i < text.length; i += 1) {
          vector[i % dims] = (vector[i % dims]! + (text.charCodeAt(i) % 10) + 0.01) % 5;
        }
        return vector;
      });
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
  return { client, embedCalls };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-vidx-"));
}

describe("vector-index", () => {
  it("upsertMany 仅对 textHash 变化的条目重新 embed", async () => {
    const dir = makeTempDir();
    try {
      const { client, embedCalls } = makeStubEmbeddingClient();
      const index = new VectorIndex({ client, storePath: join(dir, "v.jsonl") });
      await index.upsertMany([
        { id: "a", text: "创造性判断三步法" },
        { id: "b", text: "新颖性宽限期" },
      ]);
      assert.equal(embedCalls.length, 1); // 一次批量
      assert.equal(index.size, 2);

      // 内容未变：不再 embed
      await index.upsertMany([{ id: "a", text: "创造性判断三步法" }]);
      assert.equal(embedCalls.length, 1);

      // 内容变化：仅重嵌入 a
      await index.upsertMany([{ id: "a", text: "创造性判断三步法（修改）" }]);
      assert.equal(embedCalls.length, 2);
      assert.deepEqual(embedCalls[1], ["创造性判断三步法（修改）"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("search 返回按相似度排序的 top-k", async () => {
    const dir = makeTempDir();
    try {
      const { client } = makeStubEmbeddingClient();
      const index = new VectorIndex({ client, storePath: join(dir, "v.jsonl") });
      await index.upsertMany([
        { id: "close", text: "创造性判断方法" },
        { id: "far", text: "apple banana cherry" },
      ]);
      const hits = await index.search("创造性判断", 2);
      assert.equal(hits.length, 2);
      assert.equal(hits[0]!.id, "close");
      assert.ok(hits[0]!.score > hits[1]!.score);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("持久化后可重载，不重复 embed", async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "v.jsonl");
      const first = new VectorIndex({ client: makeStubEmbeddingClient().client, storePath: path });
      await first.upsertMany([{ id: "a", text: "内容甲" }]);
      assert.equal(first.size, 1);

      const { client, embedCalls } = makeStubEmbeddingClient();
      const second = new VectorIndex({ client, storePath: path });
      await second.upsertMany([{ id: "a", text: "内容甲" }]);
      assert.equal(second.size, 1);
      assert.equal(embedCalls.length, 0); // 命中持久化，零 embed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remove 删除条目并持久化", async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "v.jsonl");
      const index = new VectorIndex({ client: makeStubEmbeddingClient().client, storePath: path });
      await index.upsertMany([
        { id: "a", text: "甲" },
        { id: "b", text: "乙" },
      ]);
      index.remove(["a"]);
      assert.equal(index.size, 1);
      const hits = await index.search("乙", 1);
      assert.equal(hits[0]!.id, "b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空语料 search 返回空", async () => {
    const dir = makeTempDir();
    try {
      const index = new VectorIndex({ client: makeStubEmbeddingClient().client, storePath: join(dir, "v.jsonl") });
      assert.deepEqual(await index.search("任意", 3), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
