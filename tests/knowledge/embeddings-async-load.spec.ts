import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeEmbeddingSearch } from "../../src/knowledge/shared/knowledge-embeddings.js";

/**
 * P4 向量异步预热测试：KnowledgeEmbeddingSearch 默认异步分页加载（每页
 * setImmediate 让出事件循环），未 ready 时 search 返回 [] 并触发后台预热；
 * SATI_EMBEDDINGS_SYNC_LOAD=1 / syncLoad:true 回滚旧同步阻塞行为。
 *
 * fixture：dim=4 小库（与 embedding-consistency.spec.ts 同构），向量统一
 * [1,0,0,0]，查询 [1,0,0,0] 余弦 = 1（同源）。
 */

const silentLogger = { warn: () => {} };

/** 构造 dim=4、doc_type=case 的 embeddings fixture 库（chunkCount 个向量）。 */
function createVectorDb(chunkCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), "embeddings-async-"));
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
  const insChunk = db.prepare(
    `INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', ?, 'text', '内容')`,
  );
  const insEmbedding = db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, 'd1', ?, 4, 1.0, '2026-01-01')`,
  );
  const buf = Buffer.alloc(4 * 4);
  [1, 0, 0, 0].forEach((v, j) => buf.writeFloatLE(v, j * 4));
  for (let i = 0; i < chunkCount; i += 1) {
    const cid = insChunk.run(i).lastInsertRowid as number;
    insEmbedding.run(cid, buf);
  }
  db.close();
  return dbPath;
}

function withSearch(
  t: test.TestContext,
  dbPath: string,
  options: { syncLoad?: boolean } = {},
): KnowledgeEmbeddingSearch {
  const search = new KnowledgeEmbeddingSearch({ dbPath, logger: silentLogger, docTypes: ["case"], ...options });
  t.after(() => {
    search.close();
    rmSync(dirOf(dbPath), { recursive: true, force: true });
  });
  return search;
}

function dirOf(dbPath: string): string {
  return dbPath.slice(0, dbPath.lastIndexOf("/"));
}

test("P4: 构造后未加载（ready=false），加载后 ready=true", t => {
  const search = withSearch(t, createVectorDb(10));
  assert.equal(search.ready, false, "异步默认下构造不加载矩阵");
  assert.equal(search.loadedChunkCount(), 0);
});

test("P4: 未加载时 search 返回 [] 并触发后台预热（单飞 promise）", async t => {
  const search = withSearch(t, createVectorDb(50));
  const hits = search.search(Float32Array.from([1, 0, 0, 0]), 5);
  assert.deepEqual(hits, [], "未 ready 应返回空");
  // search 内部 void loadAsync() 已触发预热——等待同一单飞 promise 完成
  await search.loadAsync();
  assert.equal(search.ready, true, "search 应触发后台预热");
  assert.ok(search.loadedChunkCount() >= 50, "预热应加载全部 chunk");
});

test("P4: 并发 loadAsync 共享同一单飞 promise", async t => {
  const search = withSearch(t, createVectorDb(50));
  const p1 = search.loadAsync();
  const p2 = search.loadAsync();
  assert.equal(p1, p2, "并发预热应共享同一次加载");
  await p1;
  const p3 = search.loadAsync();
  assert.ok(p3 instanceof Promise, "加载完成后仍返回 promise");
  await p3;
});

test("P4: 预热让出事件循环（预热期间 timer 正常触发，不阻塞）", async t => {
  // 11000 chunks = 3 页（PAGE_SIZE 5000）——多页才能验证页间让出
  const search = withSearch(t, createVectorDb(11000));
  let timerFired = false;
  const loadPromise = search.loadAsync();
  await new Promise<void>(resolve => {
    setTimeout(() => {
      timerFired = true;
      resolve();
    }, 0);
  });
  assert.equal(timerFired, true, "预热期间事件循环应可处理 timer（页间 setImmediate 让出）");
  await loadPromise;
  assert.equal(search.ready, true);
});

test("P4: 预热完成后 search 与同步路径结果一致", async t => {
  const dbPath = createVectorDb(50);
  const asyncSearch = withSearch(t, dbPath);
  await asyncSearch.loadAsync();
  const asyncHits = asyncSearch.search(Float32Array.from([1, 0, 0, 0]), 5);

  const syncSearch = withSearch(t, dbPath, { syncLoad: true });
  const syncHits = syncSearch.search(Float32Array.from([1, 0, 0, 0]), 5);
  assert.deepEqual(asyncHits, syncHits, "异步预热结果应与同步加载逐字节一致");
  assert.ok(asyncHits.length >= 1, "同源向量应命中");
  assert.equal(asyncHits[0]!.docId, "d1");
});

test("P4: syncLoad:true 回滚同步加载（search 立即返回结果）", t => {
  const search = withSearch(t, createVectorDb(10), { syncLoad: true });
  const hits = search.search(Float32Array.from([1, 0, 0, 0]), 5);
  assert.ok(hits.length >= 1, "同步路径 search 应直接加载并命中");
  assert.equal(search.ready, true);
});

test("P4: 预热失败吞错并重置单飞（下次可重试）", async () => {
  const dbPath = createVectorDb(10);
  // 关闭 db 后句柄失效 → 预热必然失败
  const broken = new KnowledgeEmbeddingSearch({ dbPath, logger: silentLogger, docTypes: ["case"] });
  broken.close();
  const result = await broken.loadAsync();
  assert.equal(result.chunkCount, 0, "失败应返回空矩阵而非抛出");
  assert.equal(broken.ready, false, "失败后不置 ready");
  assert.equal(broken.loadedChunkCount(), 0);
  // 单飞已重置：再次调用会重新尝试（本次仍失败但不应复用旧 rejected promise）
  const retry = await broken.loadAsync();
  assert.equal(retry.chunkCount, 0);
  rmSync(dirOf(dbPath), { recursive: true, force: true });
});
