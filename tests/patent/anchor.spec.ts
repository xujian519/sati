import assert from "node:assert/strict";
import test from "node:test";
import { matchFeature, matchFeatures, normalizeText, normalizeWithOffsets } from "../../src/patent/anchor/index.js";

test("normalizeText: 全角 ASCII 转半角，全角空格折叠", () => {
  assert.equal(normalizeText("ＡＢＣ１２３　装置"), "ABC123 装置");
});

test("normalizeText: 中英文标点统一，但不改动词义", () => {
  assert.equal(normalizeText("一种装置，包括：壳体；其特征在于，"), "一种装置,包括:壳体;其特征在于,");
  assert.notEqual(normalizeText("包括"), normalizeText("包含"));
});

test("normalizeWithOffsets: 每个归一化字符都能映射回原文区间", () => {
  const input = "一种　装置";
  const normalized = normalizeWithOffsets(input);
  assert.equal(normalized.text, "一种 装置");
  assert.equal(normalized.spans.length, normalized.text.length);
  // 全角空格折叠成一个半角空格，来源区间覆盖整个空白字符
  assert.deepEqual(normalized.spans[2], { start: 2, end: 3 });
  // 末字仍指回原文末字
  assert.deepEqual(normalized.spans[4], { start: 4, end: 5 });
});

test("matchFeature: 全角特征命中半角正文，区间落在原文字符上", () => {
  const text = "本发明公开了一种ABC123装置。";
  const result = matchFeature(text, "ＡＢＣ１２３装置");
  assert.notEqual(result.hit, null);
  assert.equal(text.slice(result.hit!.start, result.hit!.end), "ABC123装置");
});

test("matchFeature: 标点写法不同仍命中", () => {
  const text = "一种装置，包括壳体。";
  const result = matchFeature(text, "一种装置,包括壳体");
  assert.notEqual(result.hit, null);
  assert.equal(result.hit!.start, 0);
  assert.equal(result.hit!.end, text.length - 1);
});

test("matchFeature: 多个空白与换行折叠后命中", () => {
  const text = "一种\n\n  连接装置";
  const result = matchFeature(text, "一种 连接装置");
  assert.notEqual(result.hit, null);
  assert.equal(text.slice(result.hit!.start, result.hit!.end), "一种\n\n  连接装置");
});

test("matchFeature: 同义改写不命中", () => {
  const text = "一种装置，包含壳体。";
  assert.equal(matchFeature(text, "一种装置，包括壳体").hit, null);
});

test("matchFeature: 缺一个技术特征就不命中（不做概括）", () => {
  const text = "一种装置，包括壳体和设置在壳体内的电机。";
  assert.equal(matchFeature(text, "一种装置，包括壳体内的电机").hit, null);
});

test("matchFeature: 空文本或空特征返回 null，不抛错", () => {
  assert.equal(matchFeature("", "装置").hit, null);
  assert.equal(matchFeature("一种装置", "").hit, null);
  assert.equal(matchFeature("一种装置", "   ").hit, null);
});

test("matchFeatures: 保持输入顺序，逐条返回结果", () => {
  const text = "一种装置，包括壳体和电机。";
  const results = matchFeatures(text, ["壳体", "齿轮", "电机"]);
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map(r => r.feature),
    ["壳体", "齿轮", "电机"],
  );
  assert.equal(results[0]!.hit === null, false);
  assert.equal(results[1]!.hit, null);
  assert.equal(results[2]!.hit === null, false);
});
