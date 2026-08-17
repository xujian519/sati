import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KgStore } from "../../src/knowledge/shared/kg-store.js";

/**
 * KgStore 关键词检索测试（searchByKeyword phrase / or 模式）。
 *
 * fixture 用默认 FTS5 unicode61 tokenizer（与真实 patent_kg.db 的 nodes_fts 一致）：
 * 连续汉字构成单个 token，短语 MATCH 需 token 完全匹配且相邻。
 */
function createStore(includeFts = true): { store: KgStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "kg-store-test-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
      law_refs_count INTEGER, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT, version TEXT
    );
    CREATE TABLE edges (source TEXT, target TEXT, relation TEXT);
  `);
  if (includeFts) {
    db.exec(`CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title, content);`);
  }
  const insert = db.prepare(`INSERT INTO nodes (id, node_type, name, title, content) VALUES (?, ?, ?, ?, ?)`);
  insert.run("n1", "GuidelineRule", "创造性", "创造性判断规则", "创造性判断的三步法框架");
  insert.run("n2", "Concept", "三步法", "三步法框架", "三步法框架概述");
  insert.run("n3", "Concept", "禁止反悔", "禁止反悔原则", "禁止反悔原则在等同侵权中的适用");
  insert.run("n4", "Concept", "创造性三步法判断", "长词测试", "创造性三步法的判断");
  insert.run("n5", "Concept", "反悔抗辩", "反悔抗辩适用", "反悔抗辩在等同侵权中的适用");
  if (includeFts) {
    const insertFts = db.prepare(`INSERT INTO nodes_fts (id, name, title, content) VALUES (?, ?, ?, ?)`);
    insertFts.run("n1", "创造性", "创造性判断规则", "创造性判断的三步法框架");
    insertFts.run("n2", "三步法", "三步法框架", "三步法框架概述");
    insertFts.run("n3", "禁止反悔", "禁止反悔原则", "禁止反悔原则在等同侵权中的适用");
    insertFts.run("n4", "创造性三步法判断", "长词测试", "创造性三步法的判断");
    insertFts.run("n5", "反悔抗辩", "反悔抗辩适用", "反悔抗辩在等同侵权中的适用");
  }
  db.close();
  return { store: new KgStore(dbPath), dir };
}

function withStore(t: test.TestContext, includeFts = true): KgStore {
  const { store, dir } = createStore(includeFts);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("kg-store: phrase 模式（默认）多词短语不命中", t => {
  const store = withStore(t);
  const nodes = store.searchByKeyword("创造性 三步法");
  assert.equal(nodes.length, 0, "unicode61 下多词短语需 token 相邻完全匹配，应不命中");
});

test("kg-store: phrase 模式单 3 字词 FTS 命中（回归既有行为）", t => {
  const store = withStore(t);
  const nodes = store.searchByKeyword("创造性");
  assert.ok(
    nodes.some(n => n.id === "n1"),
    "单 3 字词应 FTS 命中",
  );
});

test("kg-store: phrase 模式 FTS 0 命中时 LIKE 兜底", t => {
  const store = withStore(t);
  // n4 的 FTS token 为 "创造性三步法判断"，短语 '"创造性三步法"' 词级不匹配 → 降级 LIKE 子串命中
  const nodes = store.searchByKeyword("创造性三步法");
  assert.ok(
    nodes.some(n => n.id === "n4"),
    "FTS 0 命中应降级 LIKE 子串匹配",
  );
});

test("kg-store: phrase 模式带分隔符不落 LIKE 兜底", t => {
  const store = withStore(t);
  // 带分隔符短语的子串匹配（%三步法 框架%）召回率趋近于零，应直接返回空而非全表扫描
  const nodes = store.searchByKeyword("三步法 框架");
  assert.equal(nodes.length, 0, "带分隔符短语 FTS 0 命中时不触发 LIKE 兜底");
});

test("kg-store: or 模式多词召回（FTS OR 词级匹配）", t => {
  const store = withStore(t);
  const nodes = store.searchByKeyword("创造性 三步法", 10, { mode: "or" });
  const ids = nodes.map(n => n.id);
  assert.ok(ids.includes("n1"), "or 模式应命中含 创造性 token 的节点");
  assert.ok(ids.includes("n2"), "or 模式应命中含 三步法 token 的节点");
});

test("kg-store: or 模式 2 字词 LIKE 兜底", t => {
  const store = withStore(t);
  const nodes = store.searchByKeyword("反悔", 10, { mode: "or" });
  assert.ok(
    nodes.some(n => n.id === "n3"),
    "2 字词 FTS token 无法匹配，应 LIKE 子串命中",
  );
});

test("kg-store: or 模式 4-5 字无分隔词窗口子词召回", t => {
  const store = withStore(t);
  // 整体 LIKE %禁止反悔% 精确命中 n3；2 字窗口 反悔 LIKE 召回 n5（无连续 禁止反悔 字样）
  const nodes = store.searchByKeyword("禁止反悔", 10, { mode: "or" });
  const ids = nodes.map(n => n.id);
  assert.ok(ids.includes("n3"), "整体 LIKE 应命中精确子串节点");
  assert.ok(ids.includes("n5"), "2 字窗口子词应召回窗口命中节点");
});

test("kg-store: or 模式 1 字词不产生噪音", t => {
  const store = withStore(t);
  // 1 字词 LIKE %法% 命中数万节点（纯噪音），应直接丢弃
  const nodes = store.searchByKeyword("法", 10, { mode: "or" });
  assert.equal(nodes.length, 0, "1 字词不得落 LIKE 产生任意召回");
});

test("kg-store: or 模式分隔符 1 字词剔除", t => {
  const store = withStore(t);
  // 专利法（FTS）/22（LIKE）在 fixture 中无命中；第/条（1 字）不得落 LIKE 产生噪音
  const nodes = store.searchByKeyword("专利法 第 22 条", 10, { mode: "or" });
  assert.equal(nodes.length, 0, "1 字分隔子词不得产生任意召回");
});

test("kg-store: or 模式无分隔长词整体 LIKE 兜底", t => {
  const store = withStore(t);
  // n4 的 FTS token 为 "创造性三步法判断"，非 "创造性三步法"；整体 LIKE 子串命中
  const nodes = store.searchByKeyword("创造性三步法", 10, { mode: "or" });
  assert.ok(
    nodes.some(n => n.id === "n4"),
    "无分隔长词应经整体 LIKE 子串命中",
  );
});

test("kg-store: 无 FTS 表时 phrase 与 or 均降级 LIKE", t => {
  const store = withStore(t, false);
  const phrase = store.searchByKeyword("创造性");
  const or = store.searchByKeyword("创造性 三步法", 10, { mode: "or" });
  assert.ok(
    phrase.some(n => n.id === "n1"),
    "无 FTS 表应 LIKE 命中",
  );
  assert.ok(
    or.some(n => n.id === "n1"),
    "无 FTS 表 or 模式应 LIKE 命中",
  );
});

test("kg-store: ftsMode 返回 unicode61（legacy nodes_fts 默认 tokenizer）", t => {
  const store = withStore(t);
  assert.equal(store.ftsMode(), "unicode61");
});

test("kg-store: getNode 缓存命中返回同一对象引用", t => {
  const store = withStore(t);
  const first = store.getNode("n1");
  const second = store.getNode("n1");
  assert.ok(first !== undefined, "节点应可查询");
  assert.equal(first, second, "第二次查询应命中 nodeCache 返回同一对象引用");
});

test("kg-store: nodeCache LRU 上限淘汰（防 116K 节点无界膨胀）", t => {
  const dir = mkdtempSync(join(tmpdir(), "kg-store-lru-"));
  const dbPath = join(dir, "lru.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT, law_refs_count INTEGER, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT, version TEXT);
    CREATE TABLE edges (source TEXT, target TEXT, relation TEXT);
  `);
  const insert = db.prepare(`INSERT INTO nodes (id, node_type, name) VALUES (?, 'Concept', ?)`);
  const N = 9000; // > NODE_CACHE_MAX(8192)
  for (let i = 0; i < N; i++) insert.run(`n${i}`, `节点${i}`);
  db.close();
  const store = new KgStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < N; i++) store.getNode(`n${i}`);
  assert.equal(store.nodeCacheSize(), 8192, "缓存条目数应被 LRU 上限钳制");
  // 最早插入的节点已被淘汰：再次访问应重新查询并刷新访问序（缓存仍封顶）
  const rehit = store.getNode("n0");
  assert.ok(rehit !== undefined, "被淘汰节点应能从 DB 重新查询");
  assert.equal(store.nodeCacheSize(), 8192, "重新命中后缓存仍应封顶");
  // 缺失节点也占用缓存（undefined 缓存），同样受上限约束
  const missing = store.getNode("nope");
  assert.equal(missing, undefined);
  assert.equal(store.nodeCacheSize(), 8192);
});

test("kg-store: bfsPath maxDepth 截断与环防护", t => {
  const dir = mkdtempSync(join(tmpdir(), "kg-store-bfs-"));
  const dbPath = join(dir, "bfs.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT, law_refs_count INTEGER, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT, version TEXT);
    CREATE TABLE edges (source TEXT, target TEXT, relation TEXT);
    CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title, content);
  `);
  const insert = db.prepare(`INSERT INTO nodes (id, node_type, name) VALUES (?, ?, ?)`);
  for (let i = 1; i <= 8; i++) insert.run(`n${i}`, "Concept", `节点${i}`);
  const insertEdge = db.prepare(`INSERT INTO edges (source, target, relation) VALUES (?, ?, 'NEXT')`);
  // 链：n1→n2→…→n8；环：n8→n1（BFS visited 防重入，不应死循环）
  for (let i = 1; i < 8; i++) insertEdge.run(`n${i}`, `n${i + 1}`);
  insertEdge.run("n8", "n1");
  db.close();
  const store = new KgStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // 默认 maxDepth=5：n1→n8 需 7 跳超出 → null（截断而非崩溃）
  assert.equal(store.bfsPath("n1", "n8"), null);
  // 深度内可达：n1→n5 需 4 跳 ≤ 5 → 找到
  const path = store.bfsPath("n1", "n5");
  assert.ok(path !== null, "深度内可达应找到路径");
  assert.equal(path!.length, 4);
  // 环内寻路：n8→n1→n2（visited 防重入，不死循环）
  const viaCycle = store.bfsPath("n8", "n2", 10);
  assert.ok(viaCycle !== null, "环中寻路应成功");
  assert.equal(viaCycle!.length, 2);
  // fromId === toId 快速返回空路径
  assert.deepEqual(store.bfsPath("n1", "n1"), []);
});
