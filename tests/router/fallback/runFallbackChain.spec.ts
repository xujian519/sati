import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelError } from "../../../src/model/index.js";
import type { RouterFallbackConfig, RouterModelRef } from "../../../src/router/config/schema.js";
import { LITELLM_ROUTER_MAX_FALLBACKS } from "../../../src/router/config/schema.js";
import { isFallbackEligible, planFallback } from "../../../src/router/fallback/runFallbackChain.js";

function ref(id: string): RouterModelRef {
  return { id, provider: id.split("/")[0]!, model: id.split("/")[1]! };
}

function error(overrides: Partial<CanonicalModelError> = {}): CanonicalModelError {
  return { code: "unknown", retryable: true, ...overrides } as CanonicalModelError;
}

test("planFallback：未配置 fallback 时无尝试", () => {
  assert.deepEqual(planFallback(undefined, "explicit"), { attempts: [] });
  assert.deepEqual(planFallback(undefined, "subagent"), { attempts: [] });
});

test("planFallback：显式场景使用 default 列表", () => {
  const config: RouterFallbackConfig = { default: [ref("a/x"), ref("b/y")] };
  assert.deepEqual(planFallback(config, "explicit"), { attempts: [ref("a/x"), ref("b/y")] });
});

test("planFallback：按场景取对应列表", () => {
  const config: RouterFallbackConfig = {
    default: [ref("a/x")],
    subagent: [ref("b/y"), ref("c/z")],
  };
  assert.deepEqual(planFallback(config, "subagent"), { attempts: [ref("b/y"), ref("c/z")] });
});

test("planFallback：场景不存在时回退 default", () => {
  const config: RouterFallbackConfig = { default: [ref("a/x")] };
  assert.deepEqual(planFallback(config, "subagent"), { attempts: [ref("a/x")] });
});

test("planFallback：maxFallbacks 截断尝试数", () => {
  const config: RouterFallbackConfig = {
    default: [ref("a/x"), ref("b/y"), ref("c/z")],
    maxFallbacks: 2,
  };
  assert.deepEqual(planFallback(config, "explicit"), { attempts: [ref("a/x"), ref("b/y")] });
});

test("planFallback：maxFallbacks 为 0 或负数时清空", () => {
  const config: RouterFallbackConfig = { default: [ref("a/x")], maxFallbacks: 0 };
  assert.deepEqual(planFallback(config, "explicit"), { attempts: [] });
  const configNeg: RouterFallbackConfig = { default: [ref("a/x")], maxFallbacks: -1 };
  assert.deepEqual(planFallback(configNeg, "explicit"), { attempts: [] });
});

test("planFallback：未配置 maxFallbacks 时使用默认上限", () => {
  const many = Array.from({ length: 8 }, (_, i) => ref(`p${i}/m`));
  const config: RouterFallbackConfig = { default: many };
  assert.equal(planFallback(config, "explicit").attempts.length, LITELLM_ROUTER_MAX_FALLBACKS);
});

test("planFallback：media 键不进故障降级链", () => {
  const config: RouterFallbackConfig = {
    default: [ref("a/x")],
    media: [ref("v/vision")],
  };
  assert.deepEqual(planFallback(config, "explicit"), { attempts: [ref("a/x")] });
  assert.deepEqual(planFallback(config, "subagent"), { attempts: [ref("a/x")] });
});

test("isFallbackEligible：可自我纠正的错误码可回退", () => {
  assert.equal(isFallbackEligible(error({ code: "invalid_tool_arguments", retryable: false })), true);
});

test("isFallbackEligible：billing/model_not_found/auth_error 可回退", () => {
  assert.equal(isFallbackEligible(error({ code: "billing", retryable: false })), true);
  assert.equal(isFallbackEligible(error({ code: "model_not_found", retryable: false })), true);
  assert.equal(isFallbackEligible(error({ code: "auth_error", retryable: false })), true);
});

test("isFallbackEligible：非重试且不在豁免集合时不可回退", () => {
  assert.equal(isFallbackEligible(error({ code: "rate_limit", retryable: false })), false);
});

test("isFallbackEligible：可压缩/可剥离图片恢复的错误不可回退", () => {
  assert.equal(isFallbackEligible(error({ retryable: true, recoverableViaCompact: true })), false);
  assert.equal(isFallbackEligible(error({ retryable: true, recoverableViaImageStrip: true })), false);
});

test("isFallbackEligible：上下文类错误不可回退", () => {
  assert.equal(isFallbackEligible(error({ code: "prompt_too_long" })), false);
  assert.equal(isFallbackEligible(error({ code: "request_too_large" })), false);
  assert.equal(isFallbackEligible(error({ code: "context_overflow" })), false);
});

test("isFallbackEligible：普通可重试错误可回退", () => {
  assert.equal(isFallbackEligible(error({ code: "rate_limit", retryable: true })), true);
});
