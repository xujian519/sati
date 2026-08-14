import assert from "node:assert/strict";
import test from "node:test";
import { lookupModelPricing, type RouterModelPricingMap } from "../../../src/router/utils/modelPricing.js";

// 锁定 DEFAULT_PRICING 的匹配顺序：具体条目必须先于通用/旧条目命中，
// 避免 deepseek-v4-flash 错配旧 flash 价、kimi-k2.7-code-highspeed 错配 k2.7-code 价。

test("deepseek v4 models hit their own pricing entries, not legacy ones", () => {
  assert.deepEqual(lookupModelPricing("deepseek", "deepseek-v4-flash"), {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
  });
  assert.deepEqual(lookupModelPricing("deepseek", "deepseek-v4-pro"), {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
  });
});

test("legacy deepseek models map to the V4 Flash tier pricing", () => {
  assert.equal(lookupModelPricing("deepseek", "deepseek-chat").input, 0.14);
  assert.equal(lookupModelPricing("deepseek", "deepseek-reasoner").input, 0.14);
});

test("kimi models hit their own pricing entries in order", () => {
  assert.equal(lookupModelPricing("moonshot", "kimi-k3").input, 2.78);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.7-code-highspeed").input, 1.81);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.7-code").input, 0.9);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.6").input, 0.9);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.7-code-highspeed").output, 7.5);
  assert.equal(lookupModelPricing("moonshot", "kimi-k3").cacheRead, 0.28);
});

test("glm models hit their official Z.AI pricing entries in order", () => {
  assert.deepEqual(lookupModelPricing("zhipu", "glm-5.2"), { input: 1.4, output: 4.4, cacheRead: 0.26 });
  assert.deepEqual(lookupModelPricing("zhipu", "glm-5.1"), { input: 1.4, output: 4.4, cacheRead: 0.26 });
  assert.equal(lookupModelPricing("zhipu", "glm-5-turbo").output, 4.0);
  // flashx 必须先于 4.7 通用行命中
  assert.deepEqual(lookupModelPricing("zhipu", "glm-4.7-flashx"), { input: 0.07, output: 0.4, cacheRead: 0.01 });
  assert.deepEqual(lookupModelPricing("zhipu", "glm-4.7-flash"), { input: 0, output: 0, cacheRead: 0 });
  assert.deepEqual(lookupModelPricing("zhipu", "glm-4.7"), { input: 0.6, output: 2.2, cacheRead: 0.11 });
});

test("minimax models hit their official pricing entries in order", () => {
  assert.deepEqual(lookupModelPricing("minimax", "MiniMax-M3"), { input: 0.29, output: 1.17, cacheRead: 0.06 });
  // highspeed 必须先于基础型号命中
  assert.deepEqual(lookupModelPricing("minimax", "MiniMax-M2.7-highspeed"), {
    input: 0.58,
    output: 2.33,
    cacheRead: 0.06,
  });
  assert.equal(lookupModelPricing("minimax", "MiniMax-M2.7").input, 0.29);
  assert.equal(lookupModelPricing("minimax", "MiniMax-M2.5-highspeed").input, 0.58);
  assert.equal(lookupModelPricing("minimax", "MiniMax-M2.1").cacheRead, 0.03);
  assert.deepEqual(lookupModelPricing("minimax", "MiniMax-M2"), { input: 0.29, output: 1.17, cacheRead: 0.03 });
});

test("unknown models fall back to FALLBACK_PRICING", () => {
  assert.deepEqual(lookupModelPricing("local", "some-random-model"), { input: 0.5, output: 1.5 });
});

test("user pricing prefers the longest matching key for prefix collisions", () => {
  const userPricing: RouterModelPricingMap = {
    "moonshot/kimi-k2.7-code": { input: 1, output: 2 },
    "moonshot/kimi-k2.7-code-highspeed": { input: 5, output: 10 },
  };
  assert.deepEqual(lookupModelPricing("moonshot", "kimi-k2.7-code-highspeed", userPricing), {
    input: 5,
    output: 10,
  });
});

test("exact combined-key user pricing wins over substring matches", () => {
  const userPricing: RouterModelPricingMap = {
    "moonshot/kimi-k2.7-code": { input: 1, output: 2 },
    "moonshot/kimi-k3": { input: 9, output: 20 },
  };
  assert.deepEqual(lookupModelPricing("moonshot", "kimi-k3", userPricing), { input: 9, output: 20 });
});
