import assert from "node:assert/strict";
import test from "node:test";
import { checkSearchQuality } from "../../../src/patent/quality/index.js";

const GOOD_REPORT = [
  "对比文件1：CN1234567A，相关度：X，已获取全文",
  "对比文件2：US20240012345A1，相关度：Y，已获取全文",
  "对比文件3：EP1234567A1，相关度：A",
  "检索式：(壳体 OR 滤芯) AND (IPC: B01D)",
].join("\n");

test("checkSearchQuality: 未传 recall 时保持原有判定", () => {
  const result = checkSearchQuality(GOOD_REPORT);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("checkSearchQuality: recall=uncovered 判失败并列出缺失特征", () => {
  const result = checkSearchQuality(GOOD_REPORT, {
    recall: { status: "uncovered", missingFeatures: ["滤芯"] },
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes("滤芯")));
});

test("checkSearchQuality: recall=not_evaluated 判失败", () => {
  const result = checkSearchQuality(GOOD_REPORT, { recall: { status: "not_evaluated" } });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes("未评估")));
});

test("checkSearchQuality: recall=adequate 不改变通过结果", () => {
  const result = checkSearchQuality(GOOD_REPORT, { recall: { status: "adequate" } });
  assert.equal(result.passed, true);
});

test("checkSearchQuality: recall=single_pass 不补检也不判失败", () => {
  const result = checkSearchQuality(GOOD_REPORT, { recall: { status: "single_pass" } });
  assert.equal(result.passed, true);
});
