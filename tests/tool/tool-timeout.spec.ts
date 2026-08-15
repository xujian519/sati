/**
 * Registry 级工具超时测试（阶段四 T6.1）。
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fuseToolTimeout, isToolTimeout } from "../../src/tool/execution/toolTimeout.js";

test("fuseToolTimeout + isToolTimeout: deadline 到期判定为超时", async () => {
  const parent = new AbortController().signal;
  const fused = fuseToolTimeout(parent, 15);
  assert.equal(fused.aborted, false);
  await sleep(40);
  assert.equal(fused.aborted, true);
  assert.equal(isToolTimeout(fused, parent), true);
});

test("isToolTimeout: 调用方先取消则不是超时", () => {
  const controller = new AbortController();
  const fused = fuseToolTimeout(controller.signal, 1000);
  controller.abort(new Error("caller abort"));
  assert.equal(fused.aborted, true);
  assert.equal(isToolTimeout(fused, controller.signal), false);
});

test("无父信号: deadline 独立生效", async () => {
  const fused = fuseToolTimeout(undefined, 15);
  assert.equal(fused.aborted, false);
  await sleep(40);
  assert.equal(fused.aborted, true);
  assert.equal(isToolTimeout(fused, undefined), true);
});
