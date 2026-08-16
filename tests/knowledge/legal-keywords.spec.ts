import assert from "node:assert/strict";
import test from "node:test";
import { extractLawKeywords } from "../../src/knowledge/legal/keywords.js";

test("extractLawKeywords 按虚词切分为 ≥3 字片段", () => {
  assert.deepEqual(extractLawKeywords("专利侵权的赔偿标准是什么"), ["专利侵权", "赔偿标准"]);
});

test("extractLawKeywords 无虚词长词保留", () => {
  assert.deepEqual(extractLawKeywords("赔偿标准"), ["赔偿标准"]);
});

test("extractLawKeywords 2 字片段被过滤（trigram 要求 3+ 字符）", () => {
  assert.deepEqual(extractLawKeywords("赔偿 标准"), []);
});

test("extractLawKeywords 空查询返回空数组", () => {
  assert.deepEqual(extractLawKeywords(""), []);
  assert.deepEqual(extractLawKeywords("   "), []);
});

test("extractLawKeywords max 截断片段数", () => {
  assert.deepEqual(extractLawKeywords("一种新型电池的制造方法以及应用场景", 1), ["新型电池"]);
  assert.deepEqual(extractLawKeywords("一种新型电池的制造方法以及应用场景", 3), ["新型电池", "制造方法", "应用场景"]);
});
