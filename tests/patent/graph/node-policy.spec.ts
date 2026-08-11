import assert from "node:assert/strict";
import test from "node:test";
import { runNodeWithPolicy, type GraphNode } from "../../../src/patent/graph/index.js";

const okNode =
  (value: unknown): GraphNode =>
  async () => ({ key: value });

test("runNodeWithPolicy: 无策略直接成功", async () => {
  const outcome = await runNodeWithPolicy(okNode("v"), undefined, { state: {} });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.delta, { key: "v" });
});

test("runNodeWithPolicy: 重试成功（第 2 次成功）", async () => {
  let calls = 0;
  const flaky: GraphNode = async () => {
    calls += 1;
    if (calls < 2) throw new Error("boom");
    return { key: "ok" };
  };
  const outcome = await runNodeWithPolicy(flaky, { maxRetries: 2, retryDelayMs: 1 }, { state: {} });
  assert.equal(outcome.ok, true);
  assert.equal(calls, 2);
});

test("runNodeWithPolicy: 重试耗尽返回失败", async () => {
  let calls = 0;
  const alwaysFail: GraphNode = async () => {
    calls += 1;
    throw new Error("always");
  };
  const outcome = await runNodeWithPolicy(alwaysFail, { maxRetries: 3, retryDelayMs: 1 }, { state: {} });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 4);
});

test("runNodeWithPolicy: 超时跨重试截断（总时长含重试）", async () => {
  let calls = 0;
  const slow: GraphNode = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { key: "late" };
  };
  const outcome = await runNodeWithPolicy(slow, { maxRetries: 3, timeoutMs: 30, retryDelayMs: 1 }, { state: {} });
  assert.equal(outcome.ok, false);
  // 超时后不再重试：仅 1 次调用。
  assert.equal(calls, 1);
  if (!outcome.ok) assert.ok(outcome.error instanceof Error);
});

test("runNodeWithPolicy: 超时注入 AbortSignal（节点可感知）", async () => {
  let sawAbort = false;
  const abortAware: GraphNode = async ({ signal }) => {
    await new Promise<void>(resolve => {
      signal?.addEventListener("abort", () => {
        sawAbort = true;
        resolve();
      });
      setTimeout(resolve, 200);
    });
    throw new Error("aborted");
  };
  const outcome = await runNodeWithPolicy(abortAware, { timeoutMs: 20 }, { state: {} });
  assert.equal(outcome.ok, false);
  assert.equal(sawAbort, true);
});

test("runNodeWithPolicy: sideEffect 丢弃 delta", async () => {
  const outcome = await runNodeWithPolicy(okNode("v"), { sideEffect: true }, { state: {} });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.delta, {});
});

test("runNodeWithPolicy: 节点同步抛错被捕获", async () => {
  const syncThrow: GraphNode = () => {
    throw new Error("sync");
  };
  const outcome = await runNodeWithPolicy(syncThrow, undefined, { state: {} });
  assert.equal(outcome.ok, false);
});
