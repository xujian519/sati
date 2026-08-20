import assert from "node:assert/strict";
import test from "node:test";
import { extractEmbodimentIds } from "../../../src/patent/claim-coverage/skeleton.js";

test("阿拉伯数字：实施例 N / 实施方式 N 混用", () => {
  assert.deepEqual(extractEmbodimentIds("实施例 1 与实施例2以及实施方式 3"), [
    "embodiment_1",
    "embodiment_2",
    "embodiment_3",
  ]);
});

test("中文数字：实施例一 ~ 实施例十", () => {
  assert.deepEqual(extractEmbodimentIds("实施例一至实施例十"), ["embodiment_1", "embodiment_10"]);
});

test("多字中文数字（评审 I2）：实施例十一 ~ 实施例十九 解析为 11-19", () => {
  assert.deepEqual(extractEmbodimentIds("实施例十一与实施例十九"), ["embodiment_11", "embodiment_19"]);
});

test("多字中文数字不支持写法（评审 I2）：实施例九十 不猜测解析（避免误判）", () => {
  assert.deepEqual(extractEmbodimentIds("实施例九十"), []);
});

test("去重：同一编号多次出现 → 单条", () => {
  assert.deepEqual(extractEmbodimentIds("实施例1 详述，实施例1 变形，实施例 2"), ["embodiment_1", "embodiment_2"]);
});

test("升序输出（输入乱序也确定性排序）", () => {
  assert.deepEqual(extractEmbodimentIds("实施方式 3，实施例 1"), ["embodiment_1", "embodiment_3"]);
});

test("无匹配（含具体实施方式章节字样）→ 空数组", () => {
  assert.equal(extractEmbodimentIds("以下是具体实施方式：无编号实施例内容").length, 0);
  assert.deepEqual(extractEmbodimentIds("交底书无实施例段落"), []);
});

test("三位以内阿拉伯数字支持，超三位不匹配", () => {
  assert.deepEqual(extractEmbodimentIds("实施例 999"), ["embodiment_999"]);
  assert.deepEqual(extractEmbodimentIds("实施例 1000"), []);
});

test("编号后跟标点/换行均正常匹配", () => {
  assert.deepEqual(extractEmbodimentIds("实施例1：\n实施例 2。"), ["embodiment_1", "embodiment_2"]);
});

test("空文本 → 空数组", () => {
  assert.deepEqual(extractEmbodimentIds(""), []);
});
