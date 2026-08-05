import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PatentKgAdapter, resolveNodeTypes } from "../../src/knowledge/patent/patent-kg-adapter.js";
import { KgStore } from "../../src/knowledge/shared/kg-store.js";

/**
 * PatentKgAdapter 真实 SQLite fixture 测试（此前仅 mock，无 DB→KgNode 映射回归保障）。
 */

function createAdapter(t: test.TestContext): PatentKgAdapter {
  const dir = mkdtempSync(join(tmpdir(), "kg-adapter-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
      law_refs_count INTEGER, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT, version TEXT
    );
    CREATE TABLE edges (source TEXT, target TEXT, relation TEXT);
    CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title, content);
  `);
  const insert = db.prepare(
    `INSERT INTO nodes (id, node_type, name, title, content, law_refs_count, chapter, article_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("n1", "GuidelineRule", "创造性", "创造性判断规则", "创造性判断的三步法框架", 3, "第二部分", "A22.3");
  insert.run("n2", "Concept", "三步法", "三步法框架", "三步法框架概述", null, null, null);
  insert.run("n3", "SupremeCourtJudgment", "最高法判决", "判例一", "判例内容", null, null, null);
  insert.run("n4", "WikiCard", "新颖性卡片", "新颖性", "新颖性判断规则正文", null, null, null);
  insert.run("n5", "RegionalCourtJudgment", "地方法院判决", "判例二", "判例内容二", null, null, null);
  const insertFts = db.prepare(`INSERT INTO nodes_fts (id, name, title, content) VALUES (?, ?, ?, ?)`);
  insertFts.run("n1", "创造性", "创造性判断规则", "创造性判断的三步法框架");
  insertFts.run("n2", "三步法", "三步法框架", "三步法框架概述");
  insertFts.run("n4", "新颖性卡片", "新颖性", "新颖性判断规则正文");
  const insertEdge = db.prepare(`INSERT INTO edges (source, target, relation) VALUES (?, ?, ?)`);
  insertEdge.run("n1", "n2", "SIMILAR_TO");
  insertEdge.run("n1", "n3", "CITES");
  insertEdge.run("n3", "n5", "REFERENCES");
  insertEdge.run("n4", "n1", "RELATED_TO");
  db.close();

  const store = new KgStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new PatentKgAdapter(store);
}

test("resolveNodeTypes: 别名展开与透传", () => {
  assert.deepEqual(resolveNodeTypes("Judgment"), ["SupremeCourtJudgment", "RegionalCourtJudgment"]);
  assert.deepEqual(resolveNodeTypes("LawArticle"), ["Clause", "Chapter"]);
  assert.deepEqual(resolveNodeTypes("Concept"), ["Concept", "ConceptDetail", "一级概念", "二级概念", "三级概念"]);
  // 未命中别名 → 按数据库实际类型透传
  assert.deepEqual(resolveNodeTypes("IPC"), ["IPC"]);
  assert.deepEqual(resolveNodeTypes(""), []);
});

test("getNode: 真实 DB 行 → KgNode 字段映射（含空字段 → undefined）", t => {
  const adapter = createAdapter(t);
  const n1 = adapter.getNode("n1");
  assert.ok(n1);
  assert.equal(n1.id, "n1");
  assert.equal(n1.nodeType, "GuidelineRule");
  assert.equal(n1.name, "创造性");
  assert.equal(n1.title, "创造性判断规则");
  assert.equal(n1.content, "创造性判断的三步法框架");
  assert.equal(n1.lawRefsCount, 3);
  assert.equal(n1.chapter, "第二部分");
  assert.equal(n1.articleNumber, "A22.3");
  // 未填列 → undefined（而非空串）
  const n2 = adapter.getNode("n2");
  assert.equal(n2?.source, undefined);
  assert.equal(adapter.getNode("no_such_id"), undefined);
});

test("searchRelevant: keyword 命中 + similar/cites 关系扩展（via 分类）", t => {
  const adapter = createAdapter(t);
  const hits = adapter.searchRelevant("创造性", { keywordLimit: 5, expandLimit: 5 });
  const byId = new Map(hits.map(h => [h.node.id, h]));
  assert.ok(byId.has("n1"), "关键词直接命中 n1");
  assert.equal(byId.get("n1")?.via, "keyword");
  // SIMILAR_TO 扩展 → via similar
  assert.ok(byId.has("n2"), "SIMILAR_TO 邻居应被扩展");
  assert.equal(byId.get("n2")?.via, "similar");
  // CITES 扩展 → via cites
  assert.ok(byId.has("n3"), "CITES 邻居应被扩展");
  assert.equal(byId.get("n3")?.via, "cites");
  // 去重：同节点不重复出现
  assert.equal(new Set(hits.map(h => h.node.id)).size, hits.length);
});

test("searchRelevant: or 模式多词召回", t => {
  const adapter = createAdapter(t);
  const hits = adapter.searchRelevant("新颖性 三步法", { mode: "or", keywordLimit: 5, expandLimit: 0 });
  const ids = new Set(hits.map(h => h.node.id));
  assert.ok(ids.has("n4") || ids.has("n1"), "多词 OR 应召回任一命中");
});

test("getCitationChain: BFS 引用链（n1 → n5 经 n3）", t => {
  const adapter = createAdapter(t);
  const chain = adapter.getCitationChain("n1", "n5");
  assert.ok(chain && chain.length >= 2, `应找到引用链: ${JSON.stringify(chain)}`);
  assert.equal(chain![0]!.source, "n1");
  assert.equal(chain![chain!.length - 1]!.target, "n5");
  // 不可达 → null
  assert.equal(adapter.getCitationChain("n1", "n4"), null);
});

test("getNeighbors: relation 过滤与 limit", t => {
  const adapter = createAdapter(t);
  const all = adapter.getNeighbors("n1", undefined, 20);
  assert.equal(all.length, 2);
  const similar = adapter.getNeighbors("n1", "SIMILAR_TO", 20);
  assert.equal(similar.length, 1);
  assert.equal(similar[0]!.relation, "SIMILAR_TO");
});

test("listByType: 按数据库实际类型过滤（别名不在此层展开）", t => {
  const adapter = createAdapter(t);
  const judgments = adapter.listByType("SupremeCourtJudgment", 10);
  assert.equal(judgments.length, 1);
  assert.equal(judgments[0]!.id, "n3");
  const wikis = adapter.listByType("WikiCard", 10);
  assert.equal(wikis.length, 1);
});
