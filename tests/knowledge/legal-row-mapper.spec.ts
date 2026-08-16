import assert from "node:assert/strict";
import test from "node:test";
import { toRecord, toSearchResult, type LawRow } from "../../src/knowledge/legal/row-mapper.js";

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
