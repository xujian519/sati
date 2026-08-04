import assert from "node:assert/strict";
import test from "node:test";
import { lookupModelPricing, type RouterModelPricingMap } from "../../../src/router/utils/modelPricing.js";

// 锁定 DEFAULT_PRICING 的匹配顺序：具体条目必须先于通用/旧条目命中，
// 避免 deepseek-v4-flash 错配旧 flash 价、kimi-k2.7-code-highspeed 错配 k2.7-code 价。

test("deepseek v4 models hit their own pricing entries, not legacy ones", () => {
  assert.deepEqual(lookupModelPricing("deepseek", "deepseek-v4-flash"), {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.003,
  });
  assert.deepEqual(lookupModelPricing("deepseek", "deepseek-v4-pro"), {
    input: 0.42,
    output: 0.83,
    cacheRead: 0.0035,
  });
});

test("legacy deepseek models keep their deprecated pricing entries", () => {
  assert.equal(lookupModelPricing("deepseek", "deepseek-chat").input, 0.5);
  assert.equal(lookupModelPricing("deepseek", "deepseek-reasoner").input, 0.8);
});

test("kimi models hit their own pricing entries in order", () => {
  assert.equal(lookupModelPricing("moonshot", "kimi-k3").input, 2.78);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.7-code-highspeed").input, 1.81);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.7-code").input, 0.9);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.6").input, 0.9);
  assert.equal(lookupModelPricing("moonshot", "kimi-k2.7-code-highspeed").output, 7.5);
  assert.equal(lookupModelPricing("moonshot", "kimi-k3").cacheRead, 0.28);
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
