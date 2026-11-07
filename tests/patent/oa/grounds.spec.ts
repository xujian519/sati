import assert from "node:assert/strict";
import test from "node:test";
import { classifyGrounds, classifyGroundsFromLines } from "../../../src/patent/oa/grounds.js";

test("classifyGrounds: 「未识别争点」得到 unidentified", () => {
  const result = classifyGrounds("未识别争点");
  assert.deepEqual(result.codes, ["unidentified"]);
  assert.equal(result.unidentified, true);
});

test("classifyGrounds: 空文本得到 unidentified", () => {
  const result = classifyGrounds("   \n\n  ");
  assert.equal(result.unidentified, true);
});

test("classifyGrounds: 新颖性表述命中 novelty", () => {
  const result = classifyGrounds("权利要求1相对于对比文件1不具备新颖性。");
  assert.ok(result.codes.includes("novelty"));
  assert.equal(result.unidentified, false);
});

test("classifyGrounds: 同一条理由可同时命中新颖性与创造性", () => {
  const result = classifyGrounds("权利要求1不具备新颖性和创造性。");
  assert.ok(result.codes.includes("novelty"));
  assert.ok(result.codes.includes("inventiveness"));
});

test("classifyGrounds: 第 33 条命中修改超范围", () => {
  const result = classifyGrounds("上述修改超出原说明书和权利要求书记载的范围，不符合专利法第33条的规定。");
  assert.ok(result.codes.includes("amendment_scope"));
});

test("classifyGrounds: 第 26 条第 3 款命中充分公开", () => {
  const result = classifyGrounds("说明书未对该技术手段作出清楚完整的说明，不符合专利法第26条第3款。");
  assert.ok(result.codes.includes("enablement"));
});

test("classifyGrounds: 第 26 条第 4 款单独出现不误报清楚", () => {
  const result = classifyGrounds("权利要求得不到说明书支持，不符合专利法第26条第4款。");
  assert.equal(result.codes.includes("clarity"), false);
});

test("classifyGrounds: 规则未覆盖的实质文本记 other 并保留原文", () => {
  const result = classifyGrounds("申请人提交的附图存在形式缺陷。");
  assert.ok(result.codes.includes("other"));
  const other = result.evidence.find(item => item.code === "other");
  assert.equal(other?.text, "申请人提交的附图存在形式缺陷。");
});

test("classifyGrounds: Markdown 标题不产生 other", () => {
  const result = classifyGroundsFromLines(["## 审查意见通知书", "权利要求1不具备创造性。"]);
  assert.equal(result.codes.includes("other"), false);
  assert.ok(result.codes.includes("inventiveness"));
});

test("classifyGrounds: 代码按固定顺序输出，不随行序变化", () => {
  const first = classifyGrounds("不具备创造性。\n不具备新颖性。");
  const second = classifyGrounds("不具备新颖性。\n不具备创造性。");
  assert.deepEqual(first.codes, second.codes);
  assert.deepEqual(first.codes, ["novelty", "inventiveness"]);
});

test("classifyGrounds: 同一代码只保留首个命中行", () => {
  const result = classifyGrounds("权利要求1不具备新颖性。\n权利要求2也不具备新颖性。");
  const noveltyEvidence = result.evidence.filter(item => item.code === "novelty");
  assert.equal(noveltyEvidence.length, 1);
  assert.equal(noveltyEvidence[0]?.text, "权利要求1不具备新颖性。");
});
