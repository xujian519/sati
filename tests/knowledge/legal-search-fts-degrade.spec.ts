import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { LegalSearchEngine } from "../../src/knowledge/legal/legal-search.js";

/**
 * 自包含单元测试（不依赖本机大数据库）：
 * 验证 FTS5 能力探测与降级——law_fts 表存在但运行时 FTS5 不可用/查询异常时，
 * 自动降级 LIKE 而非抛 "no such module: fts5" 崩溃（回归：桌面端捆绑 Node v22.14.0）。
 */

type FtsSetup = "none" | "fake" | "real";

/** 构造临时 SQLite 库：law/category 表 + 可选 law_fts（fake=普通表，real=FTS5 虚拟表）。 */
function buildDb(setup: FtsSetup): string {
  const dir = mkdtempSync(join(tmpdir(), "legal-search-fts-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE category (id INTEGER PRIMARY KEY, name TEXT, folder TEXT, isSubFolder INTEGER, "group" TEXT, "order" INTEGER);
    CREATE TABLE law (
      id TEXT PRIMARY KEY, level TEXT, name TEXT, filename TEXT, publish TEXT,
      expired INTEGER, category_id INTEGER, subtitle TEXT, valid_from TEXT,
      content TEXT, "order" INTEGER
    );
    INSERT INTO category (id, name, "order") VALUES (1, '民法商法', 1);
    INSERT INTO law VALUES
      ('L1','法律','专利法',NULL,'2020-10-17',0,1,NULL,NULL,'同样的发明创造只能授予一项专利权。',1),
      ('L2','法律','著作权法',NULL,'2020-11-11',0,1,NULL,NULL,'著作权人享有发表权。',2),
      ('L3','法律','专利法（1992）',NULL,'1992-09-04',1,1,NULL,NULL,'1992 年旧版专利法的规定。',3);
  `);
  if (setup === "fake") {
    // 普通表冒充 law_fts：FTS5 编译可用时 MATCH 会抛异常（模拟模块缺失场景）
    db.exec(`CREATE TABLE law_fts (name TEXT, content TEXT); INSERT INTO law_fts VALUES ('专利法', 'x');`);
  } else if (setup === "real") {
    db.exec(
      `CREATE VIRTUAL TABLE law_fts USING fts5(name, content);
       INSERT INTO law_fts (name, content) VALUES ('专利法', '同样的发明创造只能授予一项专利权。');`,
    );
  }
  db.close();
  return dbPath;
}

/** 当前运行时是否支持 FTS5（决定 real 场景能否构造/断言 FTS 路径）。 */
function runtimeHasFts5(): boolean {
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe("LegalSearchEngine FTS5 能力探测与降级", () => {
  it("无 law_fts 表：直接 LIKE，ftsAvailable=false", () => {
    const dbPath = buildDb("none");
    try {
      const engine = new LegalSearchEngine(dbPath);
      assert.equal(engine.ftsAvailable, false);
      // 3 字查询（满足 FTS 长度门槛）也应走 LIKE 且不崩溃
      const rows = engine.search("专利法", { limit: 5 });
      assert.ok(rows.length > 0, "LIKE 检索应命中");
      assert.equal(rows[0].name, "专利法");
      engine.close();
    } finally {
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("law_fts 存在但 FTS5 不可用/查询异常：降级 LIKE 不崩溃，ftsAvailable=false", () => {
    const dbPath = buildDb("fake");
    try {
      const engine = new LegalSearchEngine(dbPath);
      const rows = engine.search("专利法", { limit: 5 });
      assert.ok(rows.length > 0, "降级 LIKE 应命中");
      assert.equal(rows[0].name, "专利法");
      assert.equal(engine.ftsAvailable, false, "FTS 路径异常后应标记为降级");
      // 降级后再次查询仍走 LIKE，不抛错
      const again = engine.search("著作权", { limit: 5 });
      assert.ok(again.some(r => r.name.includes("著作权")));
      engine.close();
    } finally {
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("FTS5 可用：走 FTS 路径，ftsAvailable=true（运行时不支持则跳过）", { skip: !runtimeHasFts5() }, () => {
    const dbPath = buildDb("real");
    try {
      const engine = new LegalSearchEngine(dbPath);
      assert.equal(engine.ftsAvailable, true);
      const rows = engine.search("专利法", { limit: 5 });
      assert.ok(rows.length > 0, "FTS 检索应命中");
      assert.equal(rows[0].name, "专利法");
      engine.close();
    } finally {
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("findByName / count 不依赖 FTS5，任何运行时可用", () => {
    const dbPath = buildDb("fake");
    try {
      const engine = new LegalSearchEngine(dbPath);
      const byName = engine.findByName("专利法", 3);
      assert.ok(byName.some(r => r.name === "专利法"));
      assert.equal(engine.count(), 3);
      engine.close();
    } finally {
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("A2：已失效法规不硬过滤，降权排序（现行有效在前）", () => {
    const dbPath = buildDb("none");
    try {
      const engine = new LegalSearchEngine(dbPath);
      // LIKE 路径（无 law_fts）：已失效的 专利法（1992） 应可见但排后
      const rows = engine.search("专利法", { limit: 5 });
      const expiredRow = rows.find(r => r.expired === 1);
      assert.ok(expiredRow, "已失效法规不应被硬过滤（降权而非删除）");
      assert.equal(expiredRow?.name, "专利法（1992）");
      assert.equal(rows[0]!.name, "专利法", "现行有效法规应排最前");
      engine.close();
    } finally {
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
  });
});
