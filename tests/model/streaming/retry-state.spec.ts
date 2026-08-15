/**
 * 重试状态追踪测试（阶段四 T4.2）。
 *
 * 覆盖：scope 稳定 retryId、无 scope 随机 id、retryAfterMs 封顶、
 * RetryStateTracker 记录/读取/快照。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { capRetryAfterMs, createRetryId, RetryStateTracker } from "../../../src/model/streaming/retryState.js";

test("createRetryId：同 scope 稳定、异 scope 不同、无 scope 随机", () => {
  const a = createRetryId("deepseek", "deepseek-chat", "turn-1");
  const b = createRetryId("deepseek", "deepseek-chat", "turn-1");
  assert.equal(a, b);
  const c = createRetryId("deepseek", "deepseek-chat", "turn-2");
  assert.notEqual(a, c);
  const d = createRetryId("deepseek", "deepseek-chat");
  const e = createRetryId("deepseek", "deepseek-chat");
  assert.notEqual(d, e);
  assert.ok(d.length > 0);
});

test("capRetryAfterMs：尊重服务端建议但不超过部署上限", () => {
  assert.equal(capRetryAfterMs(1000, 8000), 1000);
  assert.equal(capRetryAfterMs(9000, 8000), 8000);
  assert.equal(capRetryAfterMs(9000), 8000);
  assert.equal(capRetryAfterMs(100, 8000), 100);
});

test("RetryStateTracker：记录/读取/快照", () => {
  const tracker = new RetryStateTracker();
  const first = tracker.record({
    provider: "deepseek",
    model: "deepseek-chat",
    policyKey: "stream",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 500,
    reason: "network_error",
    scope: "turn-9",
  });
  const second = tracker.record({
    provider: "deepseek",
    model: "deepseek-chat",
    policyKey: "stream",
    attempt: 2,
    maxAttempts: 2,
    delayMs: 1000,
    reason: "network_error",
    scope: "turn-9",
  });
  // 同 scope 重试共享同一 retryId，第二次记录覆盖调度事实。
  assert.equal(first.retryId, second.retryId);
  assert.equal(tracker.get(first.retryId)?.attempt, 2);
  assert.equal(tracker.snapshot().length, 1);
  assert.equal(tracker.get("unknown-id"), undefined);
});
