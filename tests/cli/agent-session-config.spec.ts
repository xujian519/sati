import test from "node:test";
import assert from "node:assert/strict";
import { resolveRoutedModel } from "../../src/cli/agentSessionConfig.js";

const fallback = { provider: "openai", model: "gpt-4o" };

test("resolveRoutedModel uses the route when both provider and model are non-empty", () => {
  assert.deepEqual(resolveRoutedModel({ provider: "deepseek", model: "deepseek-v4" }, fallback), {
    provider: "deepseek",
    model: "deepseek-v4",
  });
});

test("resolveRoutedModel falls back when no route is present", () => {
  assert.deepEqual(resolveRoutedModel(undefined, fallback), fallback);
});

test("resolveRoutedModel falls back when the route is only half-specified", () => {
  // WS 线协议可以直传部分字段（编译期约束管不到线协议）。只判 undefined 会让
  // 空串/缺失的一半盖掉默认值，拼出 provider 与 model 不对应的模型对。
  assert.deepEqual(resolveRoutedModel({ provider: "deepseek" }, fallback), fallback);
  assert.deepEqual(resolveRoutedModel({ model: "deepseek-v4" }, fallback), fallback);
  assert.deepEqual(resolveRoutedModel({ provider: "", model: "deepseek-v4" }, fallback), fallback);
  assert.deepEqual(resolveRoutedModel({ provider: "deepseek", model: "" }, fallback), fallback);
  assert.deepEqual(resolveRoutedModel({}, fallback), fallback);
});

test("resolveRoutedModel ignores non-string route fields instead of forwarding them", () => {
  assert.deepEqual(resolveRoutedModel({ provider: 42, model: "deepseek-v4" }, fallback), fallback);
  assert.deepEqual(resolveRoutedModel({ provider: "deepseek", model: null }, fallback), fallback);
});
