import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldTransientRetry,
  shouldZeroUsageRetry,
  type TransientRetryGate,
  type ZeroUsageRetryGate,
} from "../../../src/router/retry/retryGates.js";

/**
 * 重试判据的真值表（债务 #343 / TD-ROUTER-002）。
 *
 * 这两个判据原本内联在 `RouterRuntime` 闭包的 `execute()` 里，与「发事件、算退避、
 * 等待」的副作用缠在一起。抽成纯谓词后可以逐格验证。
 *
 * 每条用例都从「全部前提满足 ⇒ 重试」的基线出发，**只翻转一个入参**并断言结果为
 * false —— 这保证「每一个入参都在承重」，而不是只测了某一个。
 */

const transientPass: TransientRetryGate = {
  hasYieldedContent: false,
  fallbackEligible: true,
  enabled: true,
  retryCount: 0,
  maxRetries: 2,
};

const zeroUsagePass: ZeroUsageRetryGate = {
  hasYieldedContent: false,
  enabled: true,
  attemptSaysRetry: true,
  attempt: 1,
  maxAttempts: 2,
};

test("transient retry：前提全满足时重试", () => {
  assert.equal(shouldTransientRetry(transientPass), true);
});

test("transient retry：任一前提不满足即不重试", () => {
  const flips: Array<[string, Partial<TransientRetryGate>]> = [
    ["已经向消费方吐出过内容", { hasYieldedContent: true }],
    ["错误不属于可重试/可回退的一类", { fallbackEligible: false }],
    ["transient retry 被配置关闭", { enabled: false }],
    ["重试次数已达上限", { retryCount: 2 }],
    ["重试次数已超上限", { retryCount: 3 }],
  ];

  for (const [label, override] of flips) {
    assert.equal(shouldTransientRetry({ ...transientPass, ...override }), false, `「${label}」时应判定为不重试`);
  }
});

test("zero-usage retry：前提全满足时重试", () => {
  assert.equal(shouldZeroUsageRetry(zeroUsagePass), true);
});

test("zero-usage retry：任一前提不满足即不重试", () => {
  const flips: Array<[string, Partial<ZeroUsageRetryGate>]> = [
    ["已经向消费方吐出过内容", { hasYieldedContent: true }],
    ["zero-usage retry 被配置关闭", { enabled: false }],
    ["上游并非「结束但零产出」", { attemptSaysRetry: false }],
    ["已用满尝试次数", { attempt: 2 }],
    ["已超出尝试次数", { attempt: 3 }],
  ];

  for (const [label, override] of flips) {
    assert.equal(shouldZeroUsageRetry({ ...zeroUsagePass, ...override }), false, `「${label}」时应判定为不重试`);
  }
});

test("内容门控优先于其它一切前提：已产出内容时两套判据都拒绝重试", () => {
  // 这是重试状态机最要紧的不变量——已吐出的文本无法收回，重试会向用户泄漏重复内容。
  assert.equal(shouldTransientRetry({ ...transientPass, hasYieldedContent: true }), false);
  assert.equal(shouldZeroUsageRetry({ ...zeroUsagePass, hasYieldedContent: true }), false);
});

test("零值边界：maxRetries/maxAttempts 为 0 时从不重试", () => {
  assert.equal(shouldTransientRetry({ ...transientPass, retryCount: 0, maxRetries: 0 }), false);
  assert.equal(shouldZeroUsageRetry({ ...zeroUsagePass, attempt: 0, maxAttempts: 0 }), false);
});
