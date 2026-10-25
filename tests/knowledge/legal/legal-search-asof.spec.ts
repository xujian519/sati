import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LegalSearchEngine } from "../../../src/knowledge/legal/legal-search.js";

/**
 * laws-full 后端 asOf 时点过滤（#735 S-05，精确口径）：
 * `valid_from <= asOf` 且 `expired = 0`；`valid_from` 缺失的行不返回，
 * 计入 unknownDateCount。失效日期不可知时排除（保守，不把已废止当行为时法）。
 */

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

function buildDb(withFts: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "legal-asof-"));
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
      ('L1','法律','专利法',NULL,'2020-10-17',0,1,NULL,'2021-06-01','专利法全文。',1),
      ('L2','法律','专利法实施细则',NULL,'2023-12-11',0,1,NULL,'2024-01-20','实施细则全文。',2),
      ('L3','法律','专利法（1992）',NULL,'1992-09-04',1,1,NULL,'1993-01-01','1992 年旧版专利法。',3),
      ('L4','法律','专利法（无施行日）',NULL,'2010-01-01',0,1,NULL,NULL,'施行日未知的专利法文本。',4);
  `);
  if (withFts) {
    db.exec(`
      CREATE VIRTUAL TABLE law_fts USING fts5(name, content);
      INSERT INTO law_fts (name, content) VALUES
        ('专利法', '专利法全文。'),
        ('专利法实施细则', '实施细则全文。'),
        ('专利法（1992）', '1992 年旧版专利法。'),
        ('专利法（无施行日）', '施行日未知的专利法文本。');
    `);
  }
  db.close();
  return dbPath;
}

function withEngine(t: test.TestContext, withFts: boolean): LegalSearchEngine {
  const dbPath = buildDb(withFts);
  const engine = new LegalSearchEngine(dbPath);
  t.after(() => {
    engine.close();
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });
  return engine;
}

test("legal-search asOf: 精确口径按 valid_from / expired 过滤，标 exact", t => {
  const engine = withEngine(t, false);
  const timed = engine.searchAt("专利法", { asOf: "2022-01-01" });
  assert.equal(timed.meta.timeFilter, "exact");
  assert.deepEqual(
    timed.results.map(r => r.name),
    ["专利法"],
    "实施条例施行日晚于 asOf、1992 版已失效、无施行日的行均不返回",
  );
  assert.equal(timed.meta.unknownDateCount, 1, "valid_from 缺失的候选计入未知");
});

test("legal-search asOf: 失效版本即使施行日早于 asOf 也不返回（保守）", t => {
  const engine = withEngine(t, false);
  const timed = engine.searchAt("专利法", { asOf: "1995-01-01" });
  assert.deepEqual(timed.results, []);
  assert.equal(timed.meta.unknownDateCount, 1);
});

test("legal-search asOf: findByName 同步应用精确过滤", t => {
  const engine = withEngine(t, false);
  assert.deepEqual(
    engine.findByName("专利法", 10, { asOf: "2022-01-01" }).map(r => r.name),
    ["专利法"],
  );
  assert.equal(engine.findByName("专利法", 10).length, 4, "缺省 findByName 不过滤");
});

test("legal-search asOf: 缺省不过滤，行为与旧版一致", t => {
  const engine = withEngine(t, false);
  assert.equal(engine.search("专利法", { limit: 10 }).length, 4);
  assert.equal(engine.searchAt("专利法", { asOf: "2025-01-01" }).results.length, 2, "L1 + L2");
});

test("legal-search asOf: FTS 路径同样应用精确过滤", { skip: !runtimeHasFts5() }, t => {
  const engine = withEngine(t, true);
  assert.equal(engine.ftsAvailable, true);
  const timed = engine.searchAt("专利法", { asOf: "2022-01-01" });
  assert.equal(timed.meta.timeFilter, "exact");
  assert.deepEqual(
    timed.results.map(r => r.name),
    ["专利法"],
  );
});
