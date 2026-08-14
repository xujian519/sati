import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeNextCronRunAt, computeNextRunAt, delayToMilliseconds } from "../../../src/cron/runtime/CronSchedule.js";

describe("computeNextRunAt", () => {
  it("once 调度返回 runAt 对应时间", () => {
    const runAt = new Date("2026-08-05T09:30:00Z");
    const next = computeNextRunAt({ type: "once", runAt: runAt.toISOString() }, new Date("2026-08-03T00:00:00Z"));
    assert.deepEqual(next, runAt);
  });

  it("once 调度 runAt 非法时返回 undefined", () => {
    const next = computeNextRunAt({ type: "once", runAt: "not-a-date" }, new Date("2026-08-03T00:00:00Z"));
    assert.equal(next, undefined);
  });

  it("delay 调度返回 after + 延迟量", () => {
    const after = new Date("2026-08-03T10:00:00Z");
    const next = computeNextRunAt({ type: "delay", amount: 90, unit: "minute" }, after);
    assert.deepEqual(next, new Date("2026-08-03T11:30:00Z"));
  });

  it("delay 调度 amount 非法时返回 undefined", () => {
    const after = new Date("2026-08-03T10:00:00Z");
    assert.equal(computeNextRunAt({ type: "delay", amount: 0, unit: "minute" }, after), undefined);
    assert.equal(computeNextRunAt({ type: "delay", amount: -5, unit: "hour" }, after), undefined);
  });

  it("cron 调度委托给 computeNextCronRunAt", () => {
    const after = new Date("2026-08-03T10:00:00Z");
    const next = computeNextRunAt({ type: "cron", expression: "*/5 * * * *", timezone: "UTC" }, after);
    assert.deepEqual(next, new Date("2026-08-03T10:05:00Z"));
  });
});

describe("delayToMilliseconds", () => {
  it("按单位换算毫秒", () => {
    assert.equal(delayToMilliseconds(2, "second"), 2_000);
    assert.equal(delayToMilliseconds(3, "minute"), 180_000);
    assert.equal(delayToMilliseconds(1, "hour"), 3_600_000);
    assert.equal(delayToMilliseconds(1, "day"), 86_400_000);
  });

  it("非法值返回 undefined", () => {
    assert.equal(delayToMilliseconds(0, "minute"), undefined);
    assert.equal(delayToMilliseconds(Number.NaN, "minute"), undefined);
    assert.equal(delayToMilliseconds(-1, "hour"), undefined);
  });
});

describe("computeNextCronRunAt", () => {
  it("每 5 分钟：from 10:00 → 10:05", () => {
    const next = computeNextCronRunAt("*/5 * * * *", new Date("2026-08-03T10:00:00Z"), "UTC");
    assert.deepEqual(next, new Date("2026-08-03T10:05:00Z"));
  });

  it("每天 09:00：from 当日 10:00 → 次日 09:00", () => {
    const next = computeNextCronRunAt("0 9 * * *", new Date("2026-08-03T10:00:00Z"), "UTC");
    assert.deepEqual(next, new Date("2026-08-04T09:00:00Z"));
  });

  it("每周一 09:00：from 周一 10:00 → 下周一 09:00", () => {
    // 2026-08-03 是周一（ISO），10:00 已过 09:00，应推进到 8/10 周一 09:00。
    const next = computeNextCronRunAt("0 9 * * 1", new Date("2026-08-03T10:00:00Z"), "UTC");
    assert.deepEqual(next, new Date("2026-08-10T09:00:00Z"));
  });

  it("精确分钟点：from 恰好 10:00 时不返回 10:00 本身", () => {
    // 语义为“下一个”触发点，起点那一分钟不算。
    const next = computeNextCronRunAt("0 10 * * *", new Date("2026-08-03T10:00:00Z"), "UTC");
    assert.deepEqual(next, new Date("2026-08-04T10:00:00Z"));
  });

  it("非法表达式返回 undefined", () => {
    assert.equal(computeNextCronRunAt("not a cron", new Date("2026-08-03T10:00:00Z"), "UTC"), undefined);
    assert.equal(computeNextCronRunAt("* * * *", new Date("2026-08-03T10:00:00Z"), "UTC"), undefined);
  });

  it("非法时区返回 undefined", () => {
    assert.equal(computeNextCronRunAt("* * * * *", new Date("2026-08-03T10:00:00Z"), "Not/AZone"), undefined);
  });

  it("2/29 闰日表达式只在下个闰年触发（跳过非闰年）", () => {
    // 2026 与 2027 均非闰年，下一次 2/29 为 2028。
    const next = computeNextCronRunAt("0 0 29 2 *", new Date("2026-08-05T00:00:00Z"), "UTC");
    assert.deepEqual(next, new Date("2028-02-29T00:00:00Z"));
    // 闰年内 2/29 之后的下一次为下一个闰年。
    const afterLeap = computeNextCronRunAt("0 0 29 2 *", new Date("2028-03-01T00:00:00Z"), "UTC");
    assert.deepEqual(afterLeap, new Date("2032-02-29T00:00:00Z"));
  });
});
