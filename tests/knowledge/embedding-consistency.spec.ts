import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import {
  checkEmbeddingConsistency,
  checkEmbeddingConsistencyOnce,
} from "../../src/knowledge/shared/embedding-consistency.js";
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
  const insChunk = db.prepare(
    `INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', ?, 'text', ?)`,
  );
  const insEmbedding = db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01')`,
  );
  // 单事务批量插入：自动提交模式下每条语句各是一次事务（2000 行 ≈ 4000 次 fsync），
  // 实测相差约 250×（CI 上单条用例曾达 6s），是测试套件里最容易被 60s 超时击中的一处。
  db.exec("BEGIN");
  chunks.forEach((chunk, i) => {
    const cid = insChunk.run(i, chunk.content).lastInsertRowid as number;
    const buf = Buffer.alloc(chunk.vector.length * 4);
    chunk.vector.forEach((v, j) => buf.writeFloatLE(v, j * 4));
    insEmbedding.run(cid, buf);
  });
  db.exec("COMMIT");
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

/** 计数客户端：记录 embed 实际发起次数，用于验证去重语义。 */
function makeCountingClient(endpointKey?: string): { client: EmbeddingClient; calls: () => number } {
  let calls = 0;
  const client: EmbeddingClient = {
    dimensions: 4,
    endpointKey,
    async embed(texts: string[]): Promise<number[][]> {
      calls += 1;
      return texts.map(() => [0.99, 0, 0, 0]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
  return { client, calls: () => calls };
}

test("embedding-consistency: 同源模型通过（均值 ≥ 阈值）", async () => {
  // 库向量统一 [1,0,0,0]（ORDER BY RANDOM 抽样顺序无关）。
  const dbPath = createKnowledgeDb([1, 2, 3, 4].map(() => ({ content: anchorText(), vector: [1, 0, 0, 0] })));
  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient(), { sampleSize: 4, threshold: 0.9 });
  assert.ok(result, "应返回自检结果");
  assert.equal(result.ok, true);
  assert.ok(result.meanCosine > 0.9, `均值应 >0.9，实际 ${result.meanCosine}`);
  assert.equal(result.sampleCount, 4);
  rmSync(dirname(dbPath), { recursive: true, force: true });
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
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test("embedding-consistency: knowledge.db 不可用返回 null（不视为失败）", async () => {
  const result = await checkEmbeddingConsistency("/nonexistent/knowledge.db", makeConsistentClient());
  assert.equal(result, null);
});

test("embedding-consistency: rowid 采样（替代 ORDER BY RANDOM）在较大库中不重复采样", async () => {
  // 2000 行：rowid 采样需返回 sampleSize 个互不重复的样本（seenRowids 去重）。
  const chunks = Array.from({ length: 2000 }, (_, i) => ({
    content: `采样锚点文本 ${i}。用于验证 rowid 起点采样不重复且覆盖可达。`.repeat(4),
    vector: [1, 0, 0, 0],
  }));
  const dbPath = createKnowledgeDb(chunks);
  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient(), { sampleSize: 8, threshold: 0.9 });
  assert.ok(result, "应返回自检结果");
  assert.equal(result.sampleCount, 8, "应恰好采样 8 个互不重复锚点");
  const texts = result!.samples.map(s => s.text);
  assert.equal(new Set(texts).size, 8, "采样文本不应重复");
  assert.equal(result!.ok, true);
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test("embedding-consistency: 空 embeddings 库返回 null", async () => {
  const dbPath = createKnowledgeDb([]);
  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient());
  assert.equal(result, null);
  rmSync(dirname(dbPath), { recursive: true, force: true });
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
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test("embedding-consistency: 截断/损坏向量行被跳过，不废掉整个自检", async () => {
  // 构造含一条损坏行的库：dim=4 但 vector 只有 2 字节（截断 BLOB）
  const dir = mkdtempSync(join(tmpdir(), "embedding-consistency-corrupt-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id), document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0);
  `);
  db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES ('d1', 'raw', 'case', '判例X', '2026-01-01')`,
  ).run();
  const cid = db
    .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', 0, 'text', ?)`)
    .run(anchorText()).lastInsertRowid as number;
  // 一条完好（float32 [1,0,0,0]）+ 一条截断（2 字节）
  const okBuf = Buffer.alloc(4 * 4);
  [1, 0, 0, 0].forEach((v, j) => okBuf.writeFloatLE(v, j * 4));
  db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01')`,
  ).run(cid, okBuf);
  const cid2 = db
    .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', 1, 'text', ?)`)
    .run(anchorText()).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01')`,
  ).run(cid2, Buffer.from([0x01, 0x02])); // 截断：byteLength(2) < dim(4)

  const result = await checkEmbeddingConsistency(dbPath, makeConsistentClient(), { sampleSize: 4, threshold: 0.9 });
  assert.ok(result, "损坏行应被跳过，自检仍应返回结果");
  assert.equal(result.ok, true, "剩余完好行同源应通过");
  db.close();
  rmSync(dir, { recursive: true, force: true });
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

/**
 * checkEmbeddingConsistencyOnce —— 启动风暴削峰的进程内去重（per-dbPath × per-endpoint 单次）。
 *
 * 成对判据：(1) 同键并发只打端点一次；(2) 换端点必须各跑一次——否则「去重」
 * 会被误实现成「忽略端点身份的全局单次」。注意一致性缓存是 module 级 Map，
 * 每个用例用独立 mkdtemp 库路径隔离键空间（同文件内不可对同库测「重跑」）。
 */
test("checkEmbeddingConsistencyOnce: 同库同端点的并发调用只发一次请求（去重命中）", async () => {
  const dbPath = createKnowledgeDb([1, 2, 3, 4].map(() => ({ content: anchorText(), vector: [1, 0, 0, 0] })));
  const { client, calls } = makeCountingClient("ep-dedupe");
  const first = checkEmbeddingConsistencyOnce(dbPath, client, { sampleSize: 4, threshold: 0.9 });
  const second = checkEmbeddingConsistencyOnce(dbPath, client, { sampleSize: 4, threshold: 0.9 });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(calls(), 1, "同一 (dbPath, endpointKey) 只应发一次 embed（23 项目启动风暴的削峰点）");
  assert.ok(r1, "首次调用应产生真实自检结果");
  assert.equal(r1.ok, true);
  assert.equal(r2, r1, "去重命中应共享同一 Promise 结果（引用相等）");
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test("checkEmbeddingConsistencyOnce: 不同端点各自执行（去重键含 endpointKey，不误并）", async () => {
  const dbPath = createKnowledgeDb([1, 2, 3, 4].map(() => ({ content: anchorText(), vector: [1, 0, 0, 0] })));
  const a = makeCountingClient("ep-a");
  const b = makeCountingClient("ep-b");
  await Promise.all([
    checkEmbeddingConsistencyOnce(dbPath, a.client, { sampleSize: 4, threshold: 0.9 }),
    checkEmbeddingConsistencyOnce(dbPath, b.client, { sampleSize: 4, threshold: 0.9 }),
  ]);
  assert.equal(a.calls(), 1, "端点 A 应恰好执行一次");
  assert.equal(b.calls(), 1, "端点 B 必须独立执行（换端点后自检结论不得被旧缓存顶替）");
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

test("checkEmbeddingConsistencyOnce: 失败同样缓存（负结果不重复打端点）", async () => {
  const dbPath = createKnowledgeDb([{ content: anchorText(), vector: [1, 0, 0, 0] }]);
  let calls = 0;
  const failing: EmbeddingClient = {
    dimensions: 4,
    endpointKey: "ep-failing",
    async embed(): Promise<number[][]> {
      calls += 1;
      throw new Error("embedding endpoint down");
    },
    async healthCheck(): Promise<boolean> {
      return false;
    },
  };
  const first = await checkEmbeddingConsistencyOnce(dbPath, failing, { logger: { warn: () => {} } });
  const second = await checkEmbeddingConsistencyOnce(dbPath, failing, { logger: { warn: () => {} } });
  assert.equal(first, null, "端点失败时自检降级返回 null");
  assert.equal(second, null);
  assert.equal(calls, 1, "失败应计入负缓存：拥塞期不得每次构建重打端点");
  rmSync(dirname(dbPath), { recursive: true, force: true });
});
