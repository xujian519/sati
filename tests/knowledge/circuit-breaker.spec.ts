import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CircuitBreaker } from "../../src/knowledge/shared/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("初始 closed，允许调用", () => {
    const breaker = new CircuitBreaker();
    assert.equal(breaker.state, "closed");
    assert.equal(breaker.allow(), true);
  });

  it("连续失败达到阈值后打开并短路", () => {
    const t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    assert.equal(breaker.allow(), true);
    breaker.failure();
    assert.equal(breaker.state, "closed"); // 1 次失败未达阈值
    breaker.failure();
    assert.equal(breaker.allow(), true); // 2 次失败仍放行
    breaker.failure();
    assert.equal(breaker.state, "open");
    assert.equal(breaker.allow(), false); // 冷却期内短路
  });

  it("冷却期未过仍拒绝", () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    breaker.failure();
    t = 999;
    assert.equal(breaker.allow(), false);
  });

  it("冷却期满进入 half-open 放行一次试探，试探在途不并发", () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    breaker.failure();
    t = 1000;
    assert.equal(breaker.state, "half-open");
    assert.equal(breaker.allow(), true);
    assert.equal(breaker.allow(), false); // 已有试探在途
  });

  it("half-open 试探成功 → 复位 closed", () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    breaker.failure();
    t = 1000;
    assert.equal(breaker.allow(), true);
    breaker.success();
    assert.equal(breaker.state, "closed");
    assert.equal(breaker.allow(), true);
  });

  it("half-open 试探失败 → 重新 open 且冷却重新计时", () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    breaker.failure(); // t=0 open
    t = 1000;
    assert.equal(breaker.allow(), true); // 试探放行
    breaker.failure(); // 重新 open，openedAt 重置为 1000
    assert.equal(breaker.state, "open");
    assert.equal(breaker.allow(), false);
    t = 1999;
    assert.equal(breaker.allow(), false); // 冷却未满
    t = 2000;
    assert.equal(breaker.allow(), true); // 冷却期满可再次试探
  });

  it("success 复位失败计数", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.failure();
    breaker.failure();
    breaker.success();
    breaker.failure();
    breaker.failure();
    assert.equal(breaker.state, "closed");
  });

  it("打开时输出 warn 日志", () => {
    const warns: unknown[][] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      logger: { warn: (...args: unknown[]) => warns.push(args) },
    });
    breaker.failure();
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]), /circuit breaker opened/);
  });
});
