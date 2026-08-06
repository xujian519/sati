import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KgStore } from "../../src/knowledge/shared/kg-store.js";

/**
 * KgStore unified schema（knowledge.db：kg_nodes/kg_edges/kg_nodes_fts）测试。
 *
 * 与 legacy schema（patent_kg.db：nodes/edges/nodes_fts*）的差异：
 *   - 表名 kg_nodes / kg_edges / kg_nodes_fts
 *   - kg_edges 列 source_id / target_id（legacy 为 source / target）
 *   - kg_nodes.law_refs 为 TEXT JSON 数组（legacy 为 law_refs_count 整数）
 *   - kg_nodes_fts 为 contentless FTS5（列仅 name/title/content，内容不存储），
 *     rowid 即 kg_nodes.rowid，检索须 JOIN 回源
 *   - 无 version 列
 */
function createUnifiedStore(): { store: KgStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "kg-store-unified-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE kg_nodes (
      id TEXT PRIMARY KEY, node_type TEXT NOT NULL, name TEXT NOT NULL, title TEXT, content TEXT,
      domain TEXT NOT NULL DEFAULT 'patent', source TEXT, full_ref TEXT, chapter TEXT,
      article_number TEXT, law_refs TEXT, priority INTEGER DEFAULT 3,
      authority_weight REAL DEFAULT 1.0, level_in_hierarchy INTEGER DEFAULT 0
    );
    CREATE TABLE kg_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      relation TEXT NOT NULL, weight REAL DEFAULT 1.0, evidence TEXT
    );
    CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(name, title, content, tokenize='trigram', content='');
  `);
  const insertNode = db.prepare(
    `INSERT INTO kg_nodes (id, node_type, name, title, content, source, law_refs) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertNode.run(
    "n1",
    "LawArticle",
    "专利法 第第二十六条",
    "专利法第二十六条",
    "说明书应当对发明作出清楚、完整的说明。",
    "专利法",
    '["专利法"]',
  );
  insertNode.run("n2", "Concept", "三步法", "三步法框架", "三步法框架概述", "wiki", "[]");
  insertNode.run("n3", "Concept", "禁止反悔", "禁止反悔原则", "禁止反悔原则在等同侵权中的适用", "wiki", "null");
  insertNode.run("n4", "IPC", "IPC_G06F", "电数字数据处理", "G06F 电数字数据处理", "IPC分类表2026.01", null);
  const insertEdge = db.prepare(`INSERT INTO kg_edges (source_id, target_id, relation) VALUES (?, ?, ?)`);
  insertEdge.run("n4", "n1", "CONTAINS");
  insertEdge.run("n4", "n2", "CITES");
  // contentless FTS：rowid 对应 kg_nodes 隐含 rowid（按插入顺序 1..4）。
  const insertFts = db.prepare(`INSERT INTO kg_nodes_fts (rowid, name, title, content) VALUES (?, ?, ?, ?)`);
  insertFts.run(1, "专利法 第第二十六条", "专利法第二十六条", "说明书应当对发明作出清楚、完整的说明。");
  insertFts.run(2, "三步法", "三步法框架", "三步法框架概述");
  insertFts.run(3, "禁止反悔", "禁止反悔原则", "禁止反悔原则在等同侵权中的适用");
  insertFts.run(4, "IPC_G06F", "电数字数据处理", "G06F 电数字数据处理");
  db.close();
  return { store: new KgStore(dbPath), dir };
}

function withUnifiedStore(t: test.TestContext): KgStore {
  const { store, dir } = createUnifiedStore();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("kg-store(unified): schema 探测为 unified，FTS 为 trigram", t => {
  const store = withUnifiedStore(t);
  assert.equal(store.schemaKind(), "unified");
  assert.equal(store.ftsMode(), "trigram", "kg_nodes_fts 恒为 trigram tokenizer");
});

test("kg-store(unified): getNode 解析 law_refs JSON 数组", t => {
  const store = withUnifiedStore(t);
  const n1 = store.getNode("n1");
  assert.ok(n1, "应能查到 LawArticle 节点");
  assert.equal(n1.lawRefsCount, 1, 'law_refs=["专利法"] → 1');
  const n2 = store.getNode("n2");
  assert.ok(n2, "应能查到 Concept 节点");
  assert.equal(n2.lawRefsCount, 0, "law_refs=[] → 0");
  const n3 = store.getNode("n3");
  assert.ok(n3, "应能查到 law_refs=null 字符串的节点");
  assert.equal(n3.lawRefsCount, undefined, 'law_refs="null"（非数组 JSON）→ undefined');
  const n4 = store.getNode("n4");
  assert.ok(n4, "应能查到 IPC 节点");
  assert.equal(n4.lawRefsCount, undefined, "law_refs=NULL → undefined");
  assert.equal(n4.source, "IPC分类表2026.01");
  assert.equal(n4.version, undefined, "unified schema 无 version 列");
});

test("kg-store(unified): searchByKeyword 经 kg_nodes_fts JOIN 回源命中", t => {
  const store = withUnifiedStore(t);
  const hits = store.searchByKeyword("三步法", 10);
  assert.ok(
    hits.some(n => n.id === "n2"),
    "FTS 应 JOIN kg_nodes 回源命中 n2",
  );
  const law = store.searchByKeyword("第二十六条", 10);
  assert.ok(
    law.some(n => n.id === "n1"),
    "法条关键词应命中 LawArticle 节点",
  );
});

test("kg-store(unified): or 模式 FTS OR + LIKE 降级正常", t => {
  const store = withUnifiedStore(t);
  const hits = store.searchByKeyword("三步法 禁止反悔", 10, { mode: "or" });
  const ids = hits.map(n => n.id);
  assert.ok(ids.includes("n2"), "or 模式应 FTS 命中 n2");
  assert.ok(ids.includes("n3"), "or 模式应 FTS 命中 n3");
});

test("kg-store(unified): getNeighbors 使用 source_id/target_id 列", t => {
  const store = withUnifiedStore(t);
  const neighbors = store.getNeighbors("n4");
  const pairs = neighbors.map(n => `${n.relation}:${n.targetId}`).sort();
  assert.deepEqual(pairs, ["CITES:n2", "CONTAINS:n1"]);
  const cites = store.getNeighbors("n4", "CITES");
  assert.deepEqual(
    cites.map(n => n.targetId),
    ["n2"],
  );
});

test("kg-store(unified): listByType 与邻居展开正常", t => {
  const store = withUnifiedStore(t);
  const ipc = store.listByType("IPC");
  assert.deepEqual(
    ipc.map(n => n.id),
    ["n4"],
  );
  const expanded = store.expandNeighbors("n4", undefined, 1);
  assert.deepEqual(expanded.map(e => e.node.id).sort(), ["n1", "n2"]);
});

test("kg-store(unified): 无 kg_nodes 表时抛出明确错误（fail-closed）", t => {
  const dir = mkdtempSync(join(tmpdir(), "kg-store-unified-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "empty.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE unrelated (id TEXT)");
  db.close();
  assert.throws(() => new KgStore(dbPath), /kg_nodes\/nodes 均不存在/);
});

test("kg-store(unified): 无 FTS 表时降级 LIKE（不崩）", t => {
  const dir = mkdtempSync(join(tmpdir(), "kg-store-unified-nofs-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE kg_nodes (
      id TEXT PRIMARY KEY, node_type TEXT NOT NULL, name TEXT NOT NULL, title TEXT, content TEXT,
      domain TEXT NOT NULL DEFAULT 'patent', source TEXT, full_ref TEXT, chapter TEXT,
      article_number TEXT, law_refs TEXT, priority INTEGER DEFAULT 3,
      authority_weight REAL DEFAULT 1.0, level_in_hierarchy INTEGER DEFAULT 0
    );
    CREATE TABLE kg_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      relation TEXT NOT NULL, weight REAL DEFAULT 1.0, evidence TEXT
    );
  `);
  db.prepare(`INSERT INTO kg_nodes (id, node_type, name, title, content) VALUES (?, ?, ?, ?, ?)`).run(
    "n1",
    "Concept",
    "三步法",
    "三步法框架",
    "三步法框架概述",
  );
  db.close();
  const store = new KgStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(store.ftsMode(), "none");
  const hits = store.searchByKeyword("三步法");
  assert.ok(
    hits.some(n => n.id === "n1"),
    "无 FTS 应 LIKE 降级命中",
  );
});
