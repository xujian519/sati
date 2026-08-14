import assert from "node:assert/strict";
import test from "node:test";
import { TokenCapManager } from "../../../src/agent/loop/tokenCapManager.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";

/**
 * TokenCapManager 单元测试（AgentLoop 拆解轮次 2）。
 */

function makeManager(
  overrides: {
    config?: Partial<{ maxContextTokens: number; maxOutputTokens: number }>;
    deps?: Partial<{
      maxContextTokens: number | undefined;
      maxOutputTokens: number | undefined;
    }>;
  } = {},
) {
  const config = { provider: "p1", model: "m1", ...overrides.config };
  const deps = {
    getModelMaxContextTokens: () => overrides.deps?.maxContextTokens,
    getModelMaxOutputTokens: () => overrides.deps?.maxOutputTokens,
    getModelTokenLimits: undefined,
  };
  return new TokenCapManager(config, deps);
}

test("currentMaxContextTokens：优先级 transient > config > deps > 默认 1M", () => {
  const mgr = makeManager({ config: { maxContextTokens: 100_000 }, deps: { maxContextTokens: 50_000 } });
  assert.equal(mgr.currentMaxContextTokens("p1", "m1"), 100_000);

  mgr.setTransientTokenCap("p1", "m1", { maxContextTokens: 200_000 });
  assert.equal(mgr.currentMaxContextTokens("p1", "m1"), 200_000, "transient 优先");

  const mgr2 = makeManager({ deps: { maxContextTokens: 50_000 } });
  assert.equal(mgr2.currentMaxContextTokens("p1", "m1"), 50_000);

  const mgr3 = makeManager({});
  assert.equal(mgr3.currentMaxContextTokens("p1", "m1"), 1_000_000, "无任何来源时回退 1M");
});

test("currentMaxOutputTokens：取各候选最小值（含模型上限）", () => {
  const mgr = makeManager({ config: { maxOutputTokens: 8_192 }, deps: { maxOutputTokens: 4_096 } });
  assert.equal(mgr.currentMaxOutputTokens("p1", "m1"), 4_096, "模型上限压制配置");

  mgr.setTransientTokenCap("p1", "m1", { attemptMaxOutputTokens: 2_048 });
  assert.equal(mgr.currentMaxOutputTokens("p1", "m1"), 2_048, "attempt 更小则胜出");
});

test("setTransientTokenCap：合并而非覆盖", () => {
  const mgr = makeManager({});
  mgr.setTransientTokenCap("p1", "m1", { maxContextTokens: 10_000 });
  mgr.setTransientTokenCap("p1", "m1", { hardMaxOutputTokens: 512 });
  assert.equal(mgr.currentMaxContextTokens("p1", "m1"), 10_000);
  assert.equal(mgr.currentMaxOutputTokens("p1", "m1"), 512);
});

test("clearAttemptOutputTokenCap：仅移除 attempt，保留其他", () => {
  const mgr = makeManager({});
  mgr.setTransientTokenCap("p1", "m1", { maxContextTokens: 10_000, attemptMaxOutputTokens: 2_048 });
  mgr.clearAttemptOutputTokenCap("p1", "m1");
  assert.equal(mgr.currentMaxContextTokens("p1", "m1"), 10_000, "context 保留");
  assert.equal(mgr.currentMaxOutputTokens("p1", "m1"), undefined, "attempt 已清除");
});

test("clearTurnScopedTokenCaps：保留 session 级（maxContext/hardMax），清除 turn 级", () => {
  const mgr = makeManager({ config: { maxContextTokens: 1_000_000 } });
  mgr.setTransientTokenCap("p1", "m1", {
    requestedMaxOutputTokens: 4_096,
    attemptMaxOutputTokens: 2_048,
    hardMaxOutputTokens: 512,
  });
  mgr.setTransientTokenCap("p2", "m2", { requestedMaxOutputTokens: 4_096 });
  mgr.clearTurnScopedTokenCaps();
  // p1/m1：hardMax 是 session 级 → 保留；attempt/requested 清除。
  assert.equal(mgr.currentMaxOutputTokens("p1", "m1"), 512);
  // p2/m2：仅 turn 级 → 整个条目删除 → 回退 config。
  assert.equal(mgr.currentMaxOutputTokens("p2", "m2"), undefined);
});

test("getReservedOutputTokens：默认用 config provider/model，可显式指定", () => {
  const mgr = makeManager({ config: { maxOutputTokens: 8_192 } });
  assert.equal(mgr.getReservedOutputTokens(), 8_192);
  assert.equal(mgr.getReservedOutputTokens("p1", "m1"), 8_192);
});

test("applyTokenCapsToRequest：注入当前 maxOutputTokens", () => {
  const mgr = makeManager({ config: { maxOutputTokens: 8_192 } });
  const request: CanonicalModelRequest = {
    provider: "old",
    model: "old-model",
    messages: [],
    stream: false,
  } as CanonicalModelRequest;
  const out = mgr.applyTokenCapsToRequest(request, "p1", "m1");
  assert.equal(out.provider, "p1");
  assert.equal(out.model, "m1");
  assert.equal(out.maxOutputTokens, 8_192);
});
