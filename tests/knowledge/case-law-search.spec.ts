import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CaseLawSearchEngine } from "../../src/knowledge/case-law/case-law-search.js";

/**
 * CaseLawSearchEngine 单元测试。
 *
 * fixture 用 contentless trigram FTS5（与真实 knowledge.db 的 docs_fts 一致）：
 * docs_fts.rowid 即 chunks.id，正文经 chunks.content 回源，再 JOIN documents。
 */
function createEngine(includeFts = true): { engine: CaseLawSearchEngine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "case-law-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, file_path TEXT, module TEXT, priority TEXT, level TEXT, publish_date TEXT,
      case_number TEXT, court TEXT, decision_number TEXT, article_number TEXT, content_hash TEXT,
      indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, heading TEXT, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE INDEX idx_chunks_document ON chunks(document_id, chunk_index);
  `);
  if (includeFts) {
    db.exec(
      `CREATE VIRTUAL TABLE docs_fts USING fts5(
        title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1
      )`,
    );
  }
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, domain, title, case_number, court, decision_number, char_count, chunk_count, indexed_at)
     VALUES (?, ?, ?, 'patent', ?, ?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
  );
  insertDoc.run("d1", "raw", "case", "专利无效复审决定 008073341", "008073341", null, "566693", 300, 2);
  insertDoc.run("d2", "raw", "judgment", "某专利侵权判决", null, "最高人民法院", null, 200, 1);
  insertDoc.run("d3", "raw", "case", "另一无效决定", "999999999", null, "777777", 100, 1);
  insertDoc.run("d4", "wiki", "case", "创造性-审查标准-磨削抛光", null, null, null, 150, 1);

  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, chunk_type, heading, content, char_count)
     VALUES (?, ?, ?, 'paragraph', NULL, ?, ?)`,
  );
  insertChunk.run(1, "d1", 0, "本案涉及创造性三步法判断，审查员认为技术方案显而易见。", 150);
  insertChunk.run(2, "d1", 1, "合议组认为区别特征产生了预料不到的技术效果。", 100);
  insertChunk.run(3, "d2", 0, "判决书正文：创造性判断应采用三步法框架进行认定。", 120);
  insertChunk.run(4, "d3", 0, "本决定认为权利要求不具备新颖性。", 80);
  insertChunk.run(5, "d4", 0, "创造性审查标准：技术启示的判断应当结合本领域技术人员认知。", 150);

  if (includeFts) {
    // contentless 表：content 参数被忽略（不存储），仅建立索引词。
    const insertFts = db.prepare(
      `INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, 'patent', NULL)`,
    );
    insertFts.run(1, "专利无效复审决定 008073341", "本案涉及创造性三步法判断，审查员认为技术方案显而易见。");
    insertFts.run(2, "专利无效复审决定 008073341", "合议组认为区别特征产生了预料不到的技术效果。");
    insertFts.run(3, "某专利侵权判决", "判决书正文：创造性判断应采用三步法框架进行认定。");
    insertFts.run(4, "另一无效决定", "本决定认为权利要求不具备新颖性。");
    insertFts.run(5, "创造性-审查标准-磨削抛光", "创造性审查标准：技术启示的判断应当结合本领域技术人员认知。");
  }
  db.close();
  return { engine: new CaseLawSearchEngine(dbPath), dir };
}

function withEngine(t: test.TestContext, includeFts = true): CaseLawSearchEngine {
  const { engine, dir } = createEngine(includeFts);
  t.after(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return engine;
}

test("case-law: FTS 命中并按文档去重（一文档一行）", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性");
  assert.ok(hits.length >= 1, "应命中含 创造性 的判例");
  const d1 = hits.find(h => h.documentId === "d1");
  assert.ok(d1, "d1 应命中（两个 chunk 均含 创造性）");
  assert.equal(d1.via, "fts");
  // 文档级聚合：d1 的两个 chunk 只出一行
  assert.equal(hits.filter(h => h.documentId === "d1").length, 1);
  // 命中 chunk 取 bm25 最高者，且 snippet 非空（contentless 需 JOIN chunks 回源）
  assert.ok(d1.snippet.length > 0, "snippet 应经 chunks 回源");
});

test("case-law: FTS 排序 bm25 越高越靠前", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性");
  // 命中按 fts_rank 降序排列（不依赖具体文档顺序，仅验证排序正确）
  const ranks = hits.map(h => h.ftsRank ?? 0);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1]! >= ranks[i]!, "命中应按 bm25 降序");
  }
});

test("case-law: doc_type 过滤", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性", { docType: "judgment" });
  assert.ok(
    hits.every(h => h.docType === "judgment"),
    "应只返回 judgment",
  );
  assert.ok(
    hits.some(h => h.documentId === "d2"),
    "应命中 d2",
  );
});

test("case-law: court 过滤（子串匹配）", t => {
  const engine = withEngine(t);
  const hits = engine.search("创造性", { court: "最高" });
  assert.ok(
    hits.every(h => h.court?.includes("最高")),
    "应只返回含 最高 法院的判例",
  );
});

test("case-law: 2 字查询直接走 LIKE 降级（trigram 需 3+ 字符）", t => {
  const engine = withEngine(t);
  // "认为" 出现在 d1 最长 chunk 与 d3 的 content（LIKE 路径取每文档最长 chunk 作片段）
  const hits = engine.search("认为");
  assert.ok(
    hits.some(h => h.documentId === "d1" && h.snippet.includes("认为")),
    "LIKE 应子串命中 d1",
  );
  assert.ok(
    hits.every(h => h.via === "like"),
    "2 字查询应走 LIKE",
  );
});

test("case-law: 无 docs_fts 表时整体降级 LIKE", t => {
  const engine = withEngine(t, false);
  assert.equal(engine.ftsAvailable, false);
  const hits = engine.search("认为");
  assert.ok(
    hits.some(h => h.documentId === "d1"),
    "无 FTS 时 LIKE 仍应命中 d1",
  );
  assert.ok(
    hits.every(h => h.via === "like"),
    "应标注 via=like",
  );
});

test("case-law: FTS 无命中时降级 LIKE", t => {
  const engine = withEngine(t);
  // "预料不到" 未出现在 FTS 词项（content 中无该 3 字连续串的完整 token？含于 d1 chunk2）
  const hits = engine.search("预料不到的技术效果");
  assert.ok(
    hits.some(h => h.documentId === "d1"),
    "FTS 无命中应降级 LIKE 命中 d1",
  );
});

test("case-law: getById 返回全文分块（按 chunk_index 排序）", t => {
  const engine = withEngine(t);
  const chunks = engine.getById("d1");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.chunkIndex, 0);
  assert.equal(chunks[1]!.chunkIndex, 1);
  assert.ok(chunks[0]!.content.includes("三步法"));
});

test("case-law: 空查询与 limit 生效", t => {
  const engine = withEngine(t);
  assert.equal(engine.search("").length, 0);
  const hits = engine.search("创造性", { limit: 1 });
  assert.equal(hits.length, 1);
});

test("case-law: count 统计", t => {
  const engine = withEngine(t);
  assert.equal(engine.count(), 4);
});

test("case-law: excludeSource 排除 wiki 审查标准卡片", t => {
  const engine = withEngine(t);
  // 不带排除：d4（source=wiki）也应命中（其 content 含 创造性）
  const all = engine.search("创造性");
  assert.ok(
    all.some(h => h.documentId === "d4"),
    "无排除时 wiki 卡片应命中",
  );
  // 排除 wiki：d4 不再出现，d1（raw）仍命中
  const rawOnly = engine.search("创造性", { excludeSource: "wiki" });
  assert.ok(!rawOnly.some(h => h.documentId === "d4"), "排除后 wiki 卡片不应命中");
  assert.ok(
    rawOnly.some(h => h.documentId === "d1"),
    "排除后仍应命中 raw 判例",
  );
});

test("case-law: 无过滤热路径走预编译语句，重复调用结果稳定", t => {
  const engine = withEngine(t);
  assert.equal(engine.ftsAvailable, true, "带 docs_fts 的 fixture 应启用 FTS");
  // 无过滤 FTS 查询走构造器预编译的 stmtSearchFts（不再逐次 prepare）
  const first = engine.search("创造性");
  const second = engine.search("创造性");
  assert.deepEqual(
    first.map(h => h.documentId),
    second.map(h => h.documentId),
    "预编译路径重复调用结果应一致",
  );
  assert.ok(first.length >= 1);
});

test("case-law: LIKE 降级路径走预编译 stmtSearchLike，重复调用稳定", t => {
  const engine = withEngine(t);
  const first = engine.search("认为");
  const second = engine.search("认为");
  assert.ok(first.length >= 1, "2 字查询应命中");
  assert.deepEqual(
    first.map(h => h.documentId).sort(),
    second.map(h => h.documentId).sort(),
    "LIKE 预编译路径重复调用结果应一致",
  );
  assert.ok(
    first.every(h => h.via === "like"),
    "2 字查询应标注 via=like",
  );
});
