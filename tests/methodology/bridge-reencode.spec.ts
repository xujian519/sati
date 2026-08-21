/**
 * bridge-reencode 方法论组件测试。
 *
 * 覆盖：触发词命中/未命中、prompt 包含重编码与桥接指令、默认注册表包含。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeReencode,
  DEFAULT_METHODOLOGY_COMPONENTS,
  extractMethodologyKeywords,
} from "../../src/methodology/index.js";

function context(goal: string) {
  return { goal, keywords: extractMethodologyKeywords(goal) };
}

test("identify scores a reasoning task", () => {
  const score = bridgeReencode.identify(context("分析这个推理步骤是否正确"));
  assert.ok(score > 0);
});

test("identify does not match ordinary conversation", () => {
  const score = bridgeReencode.identify(context("帮我打开这个文件"));
  assert.equal(score, 0);
});

test("execute returns a prompt with re-encode and bridge instructions", () => {
  const result = bridgeReencode.execute(context("推导结论"));
  assert.ok(result.prompt.includes("重编码"));
  assert.ok(result.prompt.includes("结论前桥接"));
});

test("bridge-reencode is in the default methodology set", () => {
  const names = DEFAULT_METHODOLOGY_COMPONENTS.map(component => component.name);
  assert.ok(names.includes("bridge-reencode"));
});
