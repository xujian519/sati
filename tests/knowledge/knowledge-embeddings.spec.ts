import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  KnowledgeEmbeddingSearch,
  createKnowledgeEmbeddingSearch,
} from "../../src/knowledge/shared/knowledge-embeddings.js";

/**
 * KnowledgeEmbeddingSearch 测试（knowledge.db embeddings 表复用 reader）。
 *
 * fixture 使用 4 维 float32 向量（便于手算余弦）：
 *   d1(case)  : c1=[1,0,0,0] c2=[0.9,0,0,0]（两个 chunk 验证文档级聚合）
 *   d2(law_article): c3=[0,1,0,0]
 *   d3(case)  : c4=[0,0,1,0]
 */
function createStore(): { search: KnowledgeEmbeddingSearch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-embeddings-test-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL
    );
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id),
      document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0
    );
  `);
  const insDoc = db.prepare(`INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES (?, ?, ?, ?, ?)`);
  insDoc.run("d1", "raw", "case", "无效宣告决定A", "2026-01-01");
  insDoc.run("d2", "raw", "law_article", "专利法第二十六条", "2026-01-01");
  insDoc.run("d3", "raw", "case", "无效宣告决定B", "2026-01-01");
  const insChunk = db.prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES (?, ?, ?, ?)`);
  const c1 = insChunk.run("d1", 0, "text", "内容A1").lastInsertRowid as number;
  const c2 = insChunk.run("d1", 1, "text", "内容A2").lastInsertRowid as number;
  const c3 = insChunk.run("d2", 0, "text", "法条内容").lastInsertRowid as number;
  const c4 = insChunk.run("d3", 0, "text", "内容B").lastInsertRowid as number;
  const insEmb = db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, norm, indexed_at) VALUES (?, ?, ?, 4, 1.0, '2026-01-01')`,
  );
  insEmb.run(c1, "d1", floatVec([1, 0, 0, 0]));
  insEmb.run(c2, "d1", floatVec([0.9, 0, 0, 0]));
  insEmb.run(c3, "d2", floatVec([0, 1, 0, 0]));
  insEmb.run(c4, "d3", floatVec([0, 0, 1, 0]));
  db.close();
  return { search: new KnowledgeEmbeddingSearch({ dbPath }), dir };
}

function floatVec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

function withStore(t: test.TestContext, options?: { docTypes?: string[] }): KnowledgeEmbeddingSearch {
  const { search, dir } = createStore();
  t.after(() => {
    search.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return options
    ? new KnowledgeEmbeddingSearch({ dbPath: join(dir, "knowledge.db"), docTypes: options.docTypes })
    : search;
}

test("knowledge-embeddings: available 与维度探测", t => {
  const s = withStore(t);
  assert.equal(s.available, true);
  assert.equal(s.docTypeFilter(), undefined);
});

test("knowledge-embeddings: 文档级 top-k（chunk 最高余弦聚合）", t => {
  const s = withStore(t);
  // q=[1,0,0,0]：c1=1.0, c2=1.0（0.9/0.9 归一）, c3=0, c4=0 → d1 最高
  const hits = s.search(Float32Array.from([1, 0, 0, 0]), 3);
  assert.equal(hits[0]!.docId, "d1");
  assert.ok(hits[0]!.score > 0.99, `d1 得分应≈1.0，实际 ${hits[0]!.score}`);
  assert.equal(s.loadedChunkCount(), 4);
  // limit 截断
  const one = s.search(Float32Array.from([1, 0, 0, 0]), 1);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.docId, "d1");
});

test("knowledge-embeddings: 多文档排序", t => {
  const s = withStore(t);
  // q=[0.5,0.5,0,0]：d1=0.707, d2=0.707, d3=0；limit=2 时 d3（0 分）被截断
  const hits = s.search(Float32Array.from([0.5, 0.5, 0, 0]), 2);
  const ids = hits.map(h => h.docId);
  assert.ok(ids.includes("d1") && ids.includes("d2"), `应含 d1/d2，实际 ${ids.join(",")}`);
  assert.ok(!ids.includes("d3"), "d3 余弦为 0，limit=2 时不应进入 top-k");
});

test("knowledge-embeddings: doc_type 过滤只加载匹配文档", t => {
  const s = withStore(t, { docTypes: ["law_article"] });
  assert.deepEqual(s.docTypeFilter(), ["law_article"]);
  const hits = s.search(Float32Array.from([0, 1, 0, 0]), 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.docId, "d2", "过滤后只应命中 law_article 文档");
  assert.equal(s.loadedChunkCount(), 1);
});

test("knowledge-embeddings: 维度不匹配返回空", t => {
  const s = withStore(t);
  const hits = s.search(new Float32Array(3), 3);
  assert.equal(hits.length, 0, "查询维度 ≠ 库维度应返回空");
});

test("knowledge-embeddings: 空库 available=false 且 search 安全", t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-embeddings-empty-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id), document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0);
  `);
  db.close();
  const s = new KnowledgeEmbeddingSearch({ dbPath });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(s.available, false);
  assert.deepEqual(s.search(new Float32Array(4), 3), []);
});

test("knowledge-embeddings: docTypes 过滤后无命中时 available=false（避免语义路空转）", t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-embeddings-nomatch-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id), document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0);
  `);
  // law_article 文档存在但无向量；向量只属于 case 文档 → docTypes=law_article 应不可用
  const insDoc = db.prepare(`INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES (?, ?, ?, ?, ?)`);
  insDoc.run("law1", "raw", "law_article", "专利法第一条", "2026-01-01");
  insDoc.run("c1", "raw", "case", "无效宣告决定", "2026-01-01");
  const cid = db
    .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('c1', 0, 'text', 'x')`)
    .run().lastInsertRowid as number;
  db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, indexed_at) VALUES (?, 'c1', ?, 4, '2026-01-01')`,
  ).run(cid, floatVec([1, 0, 0, 0]));
  db.close();
  const s = new KnowledgeEmbeddingSearch({ dbPath, docTypes: ["law_article"] });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(s.available, false, "docTypes 过滤后无命中应不可用");
  assert.deepEqual(s.search(Float32Array.from([1, 0, 0, 0]), 3), []);
});

test("knowledge-embeddings: 异常向量长度（超维）安全截断", t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-embeddings-len-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id INTEGER NOT NULL REFERENCES chunks(id), document_id TEXT NOT NULL REFERENCES documents(id), vector BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'bge-m3', dim INTEGER NOT NULL DEFAULT 4, indexed_at TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0.0);
  `);
  const insDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES (?, 'raw', 'case', ?, '2026-01-01')`,
  );
  insDoc.run("d1", "判例X");
  const c1 = db
    .prepare(`INSERT INTO chunks (document_id, chunk_index, chunk_type, content) VALUES ('d1', 0, 'text', 'x')`)
    .run().lastInsertRowid as number;
  // 6 维 float32（超 4 维）：应截断到 4 维而不崩
  db.prepare(
    `INSERT INTO embeddings (chunk_id, document_id, vector, dim, indexed_at) VALUES (?, 'd1', ?, 4, '2026-01-01')`,
  ).run(c1, floatVec([1, 0, 0, 0, 0.5, 0.5]));
  db.close();
  const s = new KnowledgeEmbeddingSearch({ dbPath });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const hits = s.search(Float32Array.from([1, 0, 0, 0]), 3);
  assert.equal(hits.length, 1, "超维向量截断后应可检索");
  assert.equal(hits[0]!.docId, "d1");
});

test("knowledge-embeddings: 同 dbPath+docTypes 复用共享矩阵，不重复加载", t => {
  const { search: first, dir } = createStore();
  const dbPath = join(dir, "knowledge.db");
  const logs: string[] = [];
  const second = new KnowledgeEmbeddingSearch({ dbPath, logger: { warn: m => logs.push(String(m)) } });

  t.after(() => {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  first.search(Float32Array.from([1, 0, 0, 0]), 3);
  const firstCount = first.loadedChunkCount();
  assert.equal(firstCount, 4, "首个实例应全量加载 4 个 chunk");

  // 第二个实例同路径：命中进程级缓存，不重新加载
  const hits = second.search(Float32Array.from([1, 0, 0, 0]), 3);
  assert.equal(hits[0]!.docId, "d1");
  assert.equal(second.loadedChunkCount(), 4);
  assert.ok(
    logs.some(m => m.includes("复用共享矩阵")),
    `应命中共享矩阵缓存，实际日志: ${logs.join(" | ")}`,
  );
});

test("knowledge-embeddings: 不同 docTypes 过滤不共享缓存", t => {
  const { search: all, dir } = createStore();
  const dbPath = join(dir, "knowledge.db");
  const logs: string[] = [];
  const filtered = new KnowledgeEmbeddingSearch({
    dbPath,
    docTypes: ["law_article"],
    logger: { warn: m => logs.push(String(m)) },
  });

  t.after(() => {
    all.close();
    filtered.close();
    rmSync(dir, { recursive: true, force: true });
  });

  all.search(Float32Array.from([1, 0, 0, 0]), 3);
  filtered.search(Float32Array.from([0, 1, 0, 0]), 3);
  assert.equal(filtered.loadedChunkCount(), 1, "过滤实例应加载自己的子集");
  assert.ok(
    logs.some(m => m.includes("已加载：1 docs / 1 chunks")),
    "不同 docTypes 应独立加载，实际日志: " + logs.join(" | "),
  );
});

test("knowledge-embeddings: createKnowledgeEmbeddingSearch 复用同 dbPath+docTypes 实例", t => {
  const { dir } = createStore();
  const dbPath = join(dir, "knowledge.db");
  const options = { dbPath, docTypes: ["case"] };

  const first = createKnowledgeEmbeddingSearch(options);
  const second = createKnowledgeEmbeddingSearch(options);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(first, second, "同 dbPath+docTypes 应复用同一实例（构造期全表 COUNT 只做一次）");

  // 不同 docTypes 不共享实例
  const filtered = createKnowledgeEmbeddingSearch({ dbPath, docTypes: ["law_article"] });
  assert.notEqual(filtered, first, "不同 docTypes 应各自构造");
  filtered.close();

  // close 后实例从缓存移除，下次工厂调用重新构造
  first.close();
  const recreated = createKnowledgeEmbeddingSearch(options);
  assert.notEqual(recreated, first, "close 后不应复用已关闭实例");
  recreated.close();
});
