import assert from "node:assert/strict";
import test from "node:test";
import { lawSourceConfidence, toRecord, toSearchResult, type LawRow } from "../../src/knowledge/legal/row-mapper.js";

const row: LawRow = {
  id: "专利法_20201017",
  level: "法律",
  name: "专利法",
  filename: "专利法.txt",
  publish: "2020-10-17",
  expired: 0,
  category_id: 1,
  subtitle: null,
  valid_from: "2021-06-01",
  content: "全文",
  category_name: "民法商法",
  fts_rank: -12.5,
};

test("toRecord: null 列映射为 undefined，有值列透传", () => {
  const r = toRecord(row);
  assert.equal(r.id, "专利法_20201017");
  assert.equal(r.level, "法律");
  assert.equal(r.expired, 0);
  assert.equal(r.categoryId, 1);
  assert.equal(r.categoryName, "民法商法");
  assert.equal(r.subtitle, undefined);
  assert.equal(r.validFrom, "2021-06-01");
  assert.equal(r.content, "全文");
});

test("toSearchResult: score = fts_rank", () => {
  const r = toSearchResult(row);
  assert.equal(r.score, -12.5);
  assert.equal(r.name, "专利法");
});

test("toSearchResult: 无 fts_rank 时 score 回退 0", () => {
  const r = toSearchResult({ ...row, fts_rank: undefined });
  assert.equal(r.score, 0);
});

test("A4: 地方性法规行派生 localRegulation 标记 + 低来源置信度", () => {
  const r = toRecord({ ...row, level: "地方性法规" });
  assert.equal(r.localRegulation, true);
  assert.equal(r.sourceConfidence, 0.6);
});

test("A4: 国家级法律不派生 localRegulation，来源置信度高", () => {
  const r = toRecord(row);
  assert.equal(r.localRegulation, undefined);
  assert.equal(r.sourceConfidence, 0.95);
});

test("lawSourceConfidence: 法律层级确定性映射", () => {
  assert.equal(lawSourceConfidence("宪法"), 1);
  assert.equal(lawSourceConfidence("法律"), 0.95);
  assert.equal(lawSourceConfidence("行政法规"), 0.9);
  assert.equal(lawSourceConfidence("部门规章"), 0.85);
  assert.equal(lawSourceConfidence("司法解释"), 0.8);
  assert.equal(lawSourceConfidence("地方性法规"), 0.6);
  assert.equal(lawSourceConfidence("其他"), 0.7);
});
