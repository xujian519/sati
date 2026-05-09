import assert from "node:assert/strict";
import test from "node:test";
import { computeNextCronRunAt, computeNextRunAt } from "../../src/cron/index.js";

test("computeNextRunAt returns the one-time run date", () => {
  const next = computeNextRunAt(
    { type: "once", runAt: "2026-05-09T12:00:00.000Z" },
    new Date("2026-05-09T11:00:00.000Z"),
  );
  assert.equal(next?.toISOString(), "2026-05-09T12:00:00.000Z");
});

test("computeNextCronRunAt supports step expressions", () => {
  const next = computeNextCronRunAt("*/15 * * * *", new Date("2026-05-09T12:01:30.000Z"));
  assert.equal(next?.toISOString(), "2026-05-09T12:15:00.000Z");
});

test("computeNextCronRunAt rejects invalid expressions", () => {
  assert.equal(computeNextCronRunAt("not cron", new Date("2026-05-09T12:00:00.000Z")), undefined);
});
