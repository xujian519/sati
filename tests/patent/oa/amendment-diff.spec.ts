import assert from "node:assert/strict";
import test from "node:test";
import {
  diffAmendments,
  NOT_CHECKED_REASON,
  parseAmendmentInput,
  UNSUPPORTED_REASON,
} from "../../../src/patent/oa/amendment-diff.js";

const ORIGINAL = "本发明公开了一种装置，包括壳体和设置在壳体内的电机。";

function input(original: string | null, limitations: string | null): string {
  return [
    ...(original === null ? [] : ["## original_application", original]),
    ...(limitations === null ? [] : ["## proposed_limitations", limitations]),
  ].join("\n");
}

test("parseAmendmentInput: 读取两段并去掉项目符号", () => {
  const parsed = parseAmendmentInput(input(ORIGINAL, "- 设置在壳体内的电机\n2. 壳体"));
  assert.equal(parsed.original, ORIGINAL);
  assert.deepEqual(parsed.limitations, ["设置在壳体内的电机", "壳体"]);
});

test("parseAmendmentInput: 遇到其它标题结束当前段", () => {
  const parsed = parseAmendmentInput(
    ["## original_application", ORIGINAL, "## 其他材料", "这段不属于原申请"].join("\n"),
  );
  assert.equal(parsed.original, ORIGINAL);
  assert.equal(parsed.limitations, null);
});

test("diffAmendments: 原文子串判为 anchored 并给出区间", () => {
  const result = diffAmendments(input(ORIGINAL, "设置在壳体内的电机"));
  assert.equal(result.status, "checked");
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.equal(item.status, "anchored");
  assert.equal(item.hits.length, 1);
  assert.equal(ORIGINAL.slice(item.hits[0]!.start, item.hits[0]!.end), "设置在壳体内的电机");
});

test("diffAmendments: 多出原文没有的特征判为 unsupported", () => {
  const result = diffAmendments(input(ORIGINAL, "设置在壳体内的电机和减速器"));
  const item = result.items[0]!;
  assert.equal(item.status, "unsupported");
  assert.deepEqual(item.hits, []);
  assert.equal(item.reason, UNSUPPORTED_REASON);
});

test("diffAmendments: 缺限定段为 not_checked，不产出 anchored", () => {
  const result = diffAmendments(input(ORIGINAL, null));
  assert.equal(result.status, "not_checked");
  assert.equal(result.items[0]?.status, "not_checked");
  assert.equal(result.reason, NOT_CHECKED_REASON);
});

test("diffAmendments: 缺原申请段为 not_checked", () => {
  const result = diffAmendments(input(null, "壳体"));
  assert.equal(result.status, "not_checked");
  assert.equal(result.items[0]?.status, "not_checked");
});

test("diffAmendments: 原申请段为空也视为未核对", () => {
  const result = diffAmendments(input("", "壳体"));
  assert.equal(result.status, "not_checked");
});

test("diffAmendments: 限定段存在但为空表示本次没有修改", () => {
  const result = diffAmendments(input(ORIGINAL, ""));
  assert.equal(result.status, "checked");
  assert.deepEqual(result.items, []);
});

test("diffAmendments: 输出不使用「已有依据」「实质支持」等结论词", () => {
  const serialized = JSON.stringify(diffAmendments(input(ORIGINAL, "不存在的特征")));
  for (const forbidden of ["已有依据", "实质支持", "可以概括"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
