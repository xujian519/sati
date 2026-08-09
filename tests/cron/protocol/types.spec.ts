import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapCronRunOutcome, type CronRunOutcome } from "../../../src/cron/protocol/types.js";

describe("mapCronRunOutcome", () => {
  it("outcome 为空且无 finishedAt → running", () => {
    assert.equal(mapCronRunOutcome(undefined, undefined), "running");
    assert.equal(mapCronRunOutcome(null, null), "running");
    // 空字符串视为未结束
    assert.equal(mapCronRunOutcome(undefined, ""), "running");
  });

  it("outcome 为空但有 finishedAt → completed", () => {
    assert.equal(mapCronRunOutcome(undefined, "2026-08-05T00:10:00.000Z"), "completed");
    assert.equal(mapCronRunOutcome(null, "2026-08-05T00:10:00.000Z"), "completed");
  });

  it("completed → completed（无论 finishedAt）", () => {
    assert.equal(mapCronRunOutcome("completed", "2026-08-05T00:10:00.000Z"), "completed");
    assert.equal(mapCronRunOutcome("completed", undefined), "completed");
  });

  it("failed → failed", () => {
    assert.equal(mapCronRunOutcome("failed", "2026-08-05T00:10:00.000Z"), "failed");
    assert.equal(mapCronRunOutcome("failed", undefined), "failed");
  });

  it("aborted → failed", () => {
    assert.equal(mapCronRunOutcome("aborted", "2026-08-05T00:10:00.000Z"), "failed");
  });

  it("stopped → failed", () => {
    assert.equal(mapCronRunOutcome("stopped", "2026-08-05T00:10:00.000Z"), "failed");
  });

  it("未知 outcome 兜底为 completed", () => {
    const unknown = "weird" as CronRunOutcome;
    assert.equal(mapCronRunOutcome(unknown, "2026-08-05T00:10:00.000Z"), "completed");
    assert.equal(mapCronRunOutcome(unknown, undefined), "completed");
  });
});
