import assert from "node:assert/strict";
import test from "node:test";
import { dedupeByLawName } from "../../src/knowledge/legal/dedupe.js";

test("dedupeByLawName: 同名多版本保留首个（调用方已按 publish DESC 排序 → 最新版）", () => {
  const rows = [
    { name: "专利法", version: "2020" },
    { name: "著作权法", version: "2020" },
    { name: "专利法", version: "2008" },
  ];
  const deduped = dedupeByLawName(rows, 10);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]!.name, "专利法");
  assert.equal(deduped[0]!.version, "2020");
  assert.equal(deduped[1]!.name, "著作权法");
});

test("dedupeByLawName: limit 截断", () => {
  const rows = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const deduped = dedupeByLawName(rows, 2);
  assert.equal(deduped.length, 2);
});

test("dedupeByLawName: 空输入返回空数组", () => {
  assert.deepEqual(dedupeByLawName([], 10), []);
});
