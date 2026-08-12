import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import { checkEmbeddingConsistency } from "../../src/knowledge/shared/embedding-consistency.js";
import { quantizeInt8 } from "../../src/context/vector/cosine.js";

/**
 * checkEmbeddingConsistency 测试（查询端与 knowledge.db 库向量一致性自检）。
 */

function createKnowledgeDb(chunks: Array<{ content: string; vector: number[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), "embedding-consistency-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id), document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0);
  `);
  const insDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES ('d1', 'raw', 'case', '判例X', '2026-01-01')`,
  );
  insDoc.run();
  chunks.forEach((chunk, i) => {
    const cid = db
      .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', ?, 'text', ?)`)
      .run(i, chunk.content).lastInsertRowid as number;
    const buf = Buffer.alloc(chunk.vector.length * 4);
    chunk.vector.forEach((v, j) => buf.writeFloatLE(v, j * 4));
    db.prepare(
      `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01')`,
    ).run(cid, buf);
  });
  db.close();
  return dbPath;
}

/** 返回库向量（加小扰动）的查询客户端——模拟同源模型（余弦 ≈1）。顺序无关（所有文本同向量）。 */
function makeConsistentClient(): EmbeddingClient {
  return {
    dimensions: 4,
    async embed(texts: string[]): Promise<number[][]> {
      // 1% 扰动：同源但略有量化差异
      return texts.map(() => [0.99, 0, 0, 0]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

/** 返回与库向量正交的查询客户端——模拟不同模型（余弦趋近 0）。顺序无关。 */
function makeInconsistentClient(): EmbeddingClient {
  return {
    dimensions: 4,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [0, 1, 0, 0]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

/**
 * 生成 ≥100 字符的锚点文本（一致性自检的 length BETWEEN 100 AND 500 采样下限）。
 */
function anchorText(): string {
  return "一致性自检锚点文本。用于验证查询端模型与知识库向量是否同源：".repeat(4);
}

test("embedding-consistency: 同源模型通过（均值 ≥ 阈值）", async () => {
  // 库向量统一 [1,0,0,0]（ORDER BY RANDOM 抽样顺序无关）。
  const dbPath = createKnowledgeDb([1, 2, 3, 4].map(() => ({ content: anchorText(), vector: [1, 0, 0, 0] })));
  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient(), { sampleSize: 4, threshold: 0.9 });
  assert.ok(result, "应返回自检结果");
  assert.equal(result.ok, true);
  assert.ok(result.meanCosine > 0.9, `均值应 >0.9，实际 ${result.meanCosine}`);
  assert.equal(result.sampleCount, 4);
  rmSync(dbPath, { recursive: false, force: true });
});

test("embedding-consistency: 异源模型不通过（均值 < 阈值）", async () => {
  const dbPath = createKnowledgeDb([1, 2, 3, 4].map(() => ({ content: anchorText(), vector: [1, 0, 0, 0] })));
  const result = await checkEmbeddingConsistency(dbPath, makeInconsistentClient(), {
    sampleSize: 4,
    threshold: 0.97,
  });
  assert.ok(result, "应返回自检结果");
  assert.equal(result.ok, false);
  assert.ok(result.meanCosine < 0.5, `异源模型余弦应低，实际 ${result.meanCosine}`);
  rmSync(dbPath, { recursive: false, force: true });
});

test("embedding-consistency: knowledge.db 不可用返回 null（不视为失败）", async () => {
  const result = await checkEmbeddingConsistency("/nonexistent/knowledge.db", makeConsistentClient());
  assert.equal(result, null);
});

test("embedding-consistency: 空 embeddings 库返回 null", async () => {
  const dbPath = createKnowledgeDb([]);
  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient());
  assert.equal(result, null);
  rmSync(dbPath, { recursive: false, force: true });
});

test("embedding-consistency: embedding 请求抛错时返回 null 并降级（不抛给上层）", async () => {
  const dbPath = createKnowledgeDb([{ content: anchorText(), vector: [1, 0, 0, 0] }]);
  const failing: EmbeddingClient = {
    dimensions: 4,
    async embed(): Promise<number[][]> {
      throw new Error("embedding endpoint down");
    },
    async healthCheck(): Promise<boolean> {
      return false;
    },
  };
  const result = await checkEmbeddingConsistency(dbPath, failing, { logger: { warn: () => {} } });
  assert.equal(result, null);
  rmSync(dbPath, { recursive: false, force: true });
});

test("embedding-consistency: int8 存储格式（--migrate-int8 产物，含 scale 列）反量化后同源通过", async () => {
  // 构造 int8 格式库：embeddings 表含 scale 列，vector 为 dim 字节 int8
  const dir = mkdtempSync(join(tmpdir(), "embedding-consistency-int8-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id), document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0, scale REAL NOT NULL DEFAULT 1.0);
  `);
  db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES ('d1', 'raw', 'case', '判例X', '2026-01-01')`,
  ).run();
  const cid = db
    .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', 0, 'text', ?)`)
    .run(anchorText()).lastInsertRowid as number;
  // [1,0,0,0] → int8: scale=maxAbs/127=1/127≈0.00787, values=[127,0,0,0]
  const floats = Float32Array.from([1, 0, 0, 0]);
  const { values: q, scale } = quantizeInt8(floats);
  const blob = Buffer.from(q.buffer, q.byteOffset, q.byteLength);
  db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at, scale) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01', ?)`,
  ).run(cid, blob, scale);
  db.close();

  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient(), { sampleSize: 1, threshold: 0.9 });
  assert.ok(result, "int8 格式应正常自检");
  assert.equal(result.ok, true, "反量化后同源余弦应 ≥ 阈值");
  assert.ok(result.meanCosine > 0.9, `int8 反量化余弦应 >0.9，实际 ${result.meanCosine}`);
  rmSync(dir, { recursive: true, force: true });
});
