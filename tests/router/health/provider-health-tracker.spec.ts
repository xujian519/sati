/**
 * ProviderHealthTracker 状态机单元测试（计划 T4：此前零覆盖）。
 *
 * 类无时钟注入（getState 用 Date.now 判定 open→half_open），因此：
 *   - 「open 持续」用大 openDurationMs（60s）；
 *   - 「half_open 立即到达」用 openDurationMs: 0。
 * 状态机是 M02 条目的负向演练：熔断降级（open 跳过候选）依赖它的迁移正确性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ProviderHealthTracker } from "../../../src/router/health/ProviderHealthTracker.js";

test("状态迁移：healthy→degraded→open（阈值），open 持续期内 shouldSkip=true", () => {
  const tracker = new ProviderHealthTracker({ degradeThreshold: 2, openThreshold: 4, openDurationMs: 60_000 });
  const id = "prov-a";

  assert.equal(tracker.getState(id), "healthy");
  tracker.recordFailure(id);
  assert.equal(tracker.getState(id), "healthy", "1 次失败未达 degrade 阈值");
  tracker.recordFailure(id);
  assert.equal(tracker.getState(id), "degraded", "2 次失败进入 degraded");
  tracker.recordFailure(id);
  tracker.recordFailure(id);
  assert.equal(tracker.getState(id), "open", "4 次失败进入 open");
  assert.equal(tracker.shouldSkip(id), true, "open 期必须跳过");
  assert.equal(tracker.isAvailable(id), false);
});

test("open→half_open（时长到达）→ 探测失败回 open / 探测成功回 healthy", () => {
  const tracker = new ProviderHealthTracker({ degradeThreshold: 1, openThreshold: 2, openDurationMs: 0 });
  const id = "prov-b";

  tracker.recordFailure(id);
  tracker.recordFailure(id);
  // openDurationMs=0：getState 读取即迁移 open→half_open（放行一次探测）。
  assert.equal(tracker.getState(id), "half_open");
  assert.equal(tracker.shouldSkip(id), false, "half_open 必须放行探测");

  // 探测失败：half_open → open（重新计时）；duration=0 下读取即再次迁移为 half_open。
  tracker.recordFailure(id);
  assert.equal(tracker.getState(id), "half_open");

  // 探测成功：任何非 healthy 状态一律复位 healthy。
  tracker.recordSuccess(id);
  assert.equal(tracker.getState(id), "healthy");
  assert.equal(tracker.shouldSkip(id), false);
  // successRate 是滑动窗口口径（保留历史失败），不是瞬时状态。
  assert.equal(tracker.getSuccessRate(id), 1 / 4);
});

test("recordSuccess 清零连续失败：degraded 立即恢复 healthy", () => {
  const tracker = new ProviderHealthTracker({ degradeThreshold: 2, openThreshold: 4 });
  const id = "prov-c";
  tracker.recordFailure(id);
  tracker.recordFailure(id);
  assert.equal(tracker.getState(id), "degraded");
  tracker.recordSuccess(id);
  assert.equal(tracker.getState(id), "healthy");
  tracker.recordFailure(id);
  assert.equal(tracker.getState(id), "healthy", "恢复后重新计数：1 次失败不回到 degraded");
});

test("滑动窗口：successRate 按窗口计算并裁剪", () => {
  const tracker = new ProviderHealthTracker({ windowSize: 3 });
  const id = "prov-d";
  tracker.recordSuccess(id);
  tracker.recordSuccess(id);
  tracker.recordFailure(id);
  assert.equal(tracker.getSuccessRate(id), 2 / 3);
  tracker.recordFailure(id); // 窗口 [T,T,F] → [T,F,F]（裁剪掉最早一次成功）
  assert.equal(tracker.getSuccessRate(id), 1 / 3);
  assert.equal(tracker.getSuccessRate("unknown"), 1, "未知 provider 视为完全健康");
});

test("snapshot / reset / resetAll", () => {
  const tracker = new ProviderHealthTracker({ degradeThreshold: 1, openThreshold: 2 });
  tracker.recordFailure("x");
  tracker.recordFailure("x");
  tracker.recordSuccess("y");
  const snap = tracker.snapshot();
  assert.equal(snap.get("x")?.state, "open");
  assert.equal(snap.get("x")?.consecutiveFailures, 2);
  assert.equal(snap.get("y")?.state, "healthy");

  tracker.reset("x");
  assert.equal(tracker.getState("x"), "healthy", "reset 后回到初始 healthy");
  tracker.recordFailure("y");
  tracker.resetAll();
  assert.equal(tracker.getState("y"), "healthy");
  assert.equal(tracker.snapshot().size, 0);
});
