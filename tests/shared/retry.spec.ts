import assert from "node:assert/strict";
import test from "node:test";
import { computeBackoffDelay } from "../../src/shared/retry/index.js";

/** 固定 Math.random 后执行纯函数，锁定抖动确定性。 */
function withRandom(value: number, fn: () => number): number {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

test("exponential growth doubles base delay per attempt (no jitter)", () => {
  for (const attempt of [0, 1, 2, 3]) {
    assert.equal(
      withRandom(0, () => computeBackoffDelay(attempt, { baseMs: 100, capMs: 10_000 })),
      100 * 2 ** attempt,
    );
  }
});

test("exponential growth caps the base term and the jittered sum", () => {
  assert.equal(
    withRandom(0.5, () => computeBackoffDelay(10, { baseMs: 100, capMs: 5_000 })),
    5_000, // base 102400 → cap 5000；抖动后再次封顶
  );
});

test("exponential jitter is floor(random * floor(delay * 0.25))", () => {
  // delay=1000 → floor(1000*0.25)=250 → jitter=floor(random*250)
  assert.equal(
    withRandom(0, () => computeBackoffDelay(0, { baseMs: 1000, capMs: 10_000 })),
    1000,
  );
  assert.equal(
    withRandom(0.5, () => computeBackoffDelay(0, { baseMs: 1000, capMs: 10_000 })),
    1125,
  );
  assert.equal(
    withRandom(1, () => computeBackoffDelay(0, { baseMs: 1000, capMs: 10_000 })),
    1250,
  );
});

test("exponential jitter lower bound max(1, ...) keeps tiny delays stable", () => {
  // delay=1 → floor(0.25)=0 → max(1,0)=1 → jitter=floor(random*1)，random<1 时为 0
  assert.equal(
    withRandom(0.999, () => computeBackoffDelay(0, { baseMs: 1, capMs: 10 })),
    1,
  );
});

test("linear growth is base * (attempt + 1) (no jitter)", () => {
  for (const attempt of [0, 1, 2, 3]) {
    assert.equal(
      withRandom(0, () => computeBackoffDelay(attempt, { baseMs: 100, capMs: 10_000, growth: "linear" })),
      100 * (attempt + 1),
    );
  }
});

test("linear jitter is delay * ratio * random and capped", () => {
  // delay=200，ratio=0.1 → jitter=20*random
  assert.equal(
    withRandom(0.5, () => computeBackoffDelay(1, { baseMs: 100, capMs: 10_000, growth: "linear", jitterRatio: 0.1 })),
    210,
  );
  // delay=6000 → cap 5000，抖动后仍封顶
  assert.equal(
    withRandom(0.5, () => computeBackoffDelay(5, { baseMs: 1000, capMs: 5_000, growth: "linear" })),
    5_000,
  );
});

test("retryAfterMs overrides growth and is capped at capMs", () => {
  assert.equal(computeBackoffDelay(0, { baseMs: 100, capMs: 10_000 }, 2_000), 2_000);
  assert.equal(computeBackoffDelay(0, { baseMs: 100, capMs: 5_000 }, 6_000), 5_000);
  assert.equal(computeBackoffDelay(0, { baseMs: 100, capMs: 5_000, growth: "linear" }, 2_000), 2_000);
  // retryAfterMs === 0 边界：min(cap, 0) = 0
  assert.equal(computeBackoffDelay(0, { baseMs: 100, capMs: 5_000 }, 0), 0);
});

test("default jitterRatio is 0.25 for both growth modes", () => {
  assert.equal(
    withRandom(0.5, () => computeBackoffDelay(0, { baseMs: 1000, capMs: 10_000 })),
    1125,
  );
  assert.equal(
    withRandom(0.5, () => computeBackoffDelay(0, { baseMs: 1000, capMs: 10_000, growth: "linear" })),
    1125, // 1000 + 1000*0.25*0.5
  );
});
