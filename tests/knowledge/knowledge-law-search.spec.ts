import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeLawSearch } from "../../src/knowledge/legal/knowledge-law-search.js";

/**
 * KnowledgeLawSearch 测试（knowledge.db 法规后端）。
 *
 * fixture 对齐真实库：documents(doc_type='law_article') + chunks + docs_fts
 * （contentless FTS5 trigram，rowid = chunks.id）。
 */
function createStore(): { search: KnowledgeLawSearch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-law-search-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE docs_fts USING fts5(title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1);
  `);
  const insDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES (?, 'raw', ?, ?, '2026-01-01', ?)`,
  );
  insDoc.run("law:专利法", "law_article", "中华人民共和国专利法", "法律");
  insDoc.run("law:实施细则", "law_article", "中华人民共和国专利法实施细则", "行政法规");
  // 非法规文档（doc_type=case）：不应被 law_article 检索命中
  insDoc.run("raw:无效复审决定:xx", "case", "某无效决定", null);
  const insChunk = db.prepare(
    `INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES (?, ?, 'text', ?, ?)`,
  );
  const c1 = insChunk.run("law:专利法", 0, "第一条 为了保护专利权人的合法权益，鼓励发明创造。", 30)
    .lastInsertRowid as number;
  const c2 = insChunk.run("law:专利法", 1, "第二十六条 说明书应当对发明作出清楚、完整的说明。", 26)
    .lastInsertRowid as number;
  const c3 = insChunk.run("law:实施细则", 0, "本细则依据专利法制订，对专利申请与审查程序作出具体规定。", 33)
    .lastInsertRowid as number;
  insChunk.run("raw:无效复审决定:xx", 0, "决定正文内容", 7);
  const insFts = db.prepare(
    `INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, 'module', 'patent', NULL)`,
  );
  insFts.run(c1, "中华人民共和国专利法", "第一条 为了保护专利权人的合法权益，鼓励发明创造。");
  insFts.run(c2, "中华人民共和国专利法", "第二十六条 说明书应当对发明作出清楚、完整的说明。");
  insFts.run(c3, "中华人民共和国专利法实施细则", "本细则依据专利法制订，对专利申请与审查程序作出具体规定。");
  db.close();
  return { search: new KnowledgeLawSearch(dbPath), dir };
}

function withStore(t: test.TestContext): KnowledgeLawSearch {
  const { search, dir } = createStore();
  t.after(() => {
    search.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return search;
}

test("knowledge-law-search: FTS 命中并按文档去重", t => {
  const s = withStore(t);
  const hits = s.search("第二十六条");
  assert.equal(hits.length, 1, "一文档一行（去重）");
  assert.equal(hits[0]!.name, "中华人民共和国专利法");
  assert.equal(hits[0]!.level, "法律");
  assert.ok(hits[0]!.content!.includes("说明书应当"), "content 应为命中/最长 chunk");
});

test("knowledge-law-search: LIKE 降级打在内容表——contentless 虚表 LIKE 零结果陷阱回归", t => {
  // H6：社区证实 contentless trigram 虚表上 LIKE 返回零结果（无原文可校验）——
  // 降级路径必须打在内容表（documents/chunks），否则短词/无 FTS 场景会静默空返回。
  const { search, dir } = createStore();
  t.after(() => {
    search.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(join(dir, "knowledge.db"), { readOnly: true });
  try {
    const ftsLike = db.prepare("SELECT count(*) c FROM docs_fts WHERE docs_fts LIKE '%说明书%'").get() as {
      c: number;
    };
    assert.equal(ftsLike.c, 0, "contentless 虚表 LIKE 应零结果（陷阱确认）");
  } finally {
    db.close();
  }
  // 引擎 LIKE 降级（2 字查询 < FTS_MIN_RUNES）：打在内容表，命中非零。
  // 注：LIKE 路径匹配"最长 chunk"（子查询取片段），fixture 最长 chunk 含"专利"。
  const hits = search.search("专利", { limit: 5 });
  assert.ok(hits.length > 0, "LIKE 降级应命中内容表数据");
  assert.ok(hits[0]!.content!.includes("专利"), "片段应含命中词（最长 chunk 回源）");
});

test("knowledge-law-search: 非 law_article 文档不命中", t => {
  const s = withStore(t);
  const hits = s.search("无效决定");
  assert.equal(hits.length, 0, "doc_type 过滤应排除判例文档");
});

test("knowledge-law-search: level 过滤", t => {
  const s = withStore(t);
  const hits = s.search("专利", { level: "行政法规" });
  assert.deepEqual(
    hits.map(h => h.name),
    ["中华人民共和国专利法实施细则"],
  );
});

test("knowledge-law-search: 短查询/无 FTS 降级 LIKE", t => {
  const s = withStore(t);
  const hits = s.search("发明创造", { limit: 5 });
  assert.ok(
    hits.some(h => h.name === "中华人民共和国专利法"),
    "LIKE 子串应命中",
  );
});

test("knowledge-law-search: getById/getByIds 按 documents.id 回源", t => {
  const s = withStore(t);
  const byId = s.getById("law:专利法");
  assert.equal(byId?.name, "中华人民共和国专利法");
  assert.equal(byId?.level, "法律");
  const byIds = s.getByIds(["law:实施细则", "law:专利法", "不存在"]);
  assert.deepEqual(
    byIds.map(r => r.name),
    ["中华人民共和国专利法实施细则", "中华人民共和国专利法"],
  );
});

test("knowledge-law-search: findByName 模糊查找与 count", t => {
  const s = withStore(t);
  const found = s.findByName("实施细则");
  assert.deepEqual(
    found.map(r => r.name),
    ["中华人民共和国专利法实施细则"],
  );
  assert.equal(s.count(), 2, "仅统计 law_article 文档");
  assert.deepEqual(s.getCategories(), []);
});

test("knowledge-law-search: 无 law_article 时 count 为 0 且 search 安全", t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-law-search-empty-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0);
  `);
  db.close();
  const s = new KnowledgeLawSearch(dbPath);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(s.count(), 0);
  assert.deepEqual(s.search("专利"), []);
  assert.equal(s.ftsAvailable, false, "无 docs_fts 表时应探测为不可用");
});
