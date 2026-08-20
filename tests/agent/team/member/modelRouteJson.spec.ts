/**
 * parseModelRouteJson 表驱动（质量评审 M2）：全有或全无——provider/model 双字段
 * 非空字符串才返回；部分字段/空串/非字符串/顶层非对象/非法 JSON 一律降级 {}。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseModelRouteJson } from "../../../../src/agent/team/index.js";

test("parseModelRouteJson：双字段非空才返回，其余形态降级为空对象", () => {
  const cases: Array<{ json: string; expected: { provider?: string; model?: string } }> = [
    { json: `{"provider":"x"}`, expected: {} }, // model 缺 → {}
    { json: `{"model":"y"}`, expected: {} }, // provider 缺 → {}
    { json: `{"provider":"","model":""}`, expected: {} }, // 空串 → {}
    { json: `{"provider":123}`, expected: {} }, // 非字符串 → {}
    { json: `{"provider":"x","model":"y","reasoningEffort":"low"}`, expected: { provider: "x", model: "y" } }, // 剔除多余字段
    { json: `null`, expected: {} }, // 顶层非对象 → {}
    { json: `[]`, expected: {} }, // 顶层数组 → {}
    { json: `"{broken"`, expected: {} }, // 非法 JSON → {}
  ];
  for (const { json, expected } of cases) {
    assert.deepEqual(parseModelRouteJson(json), expected, `input: ${json}`);
  }
});
