import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CronConfig } from "../../../src/cron/config/parseCronConfig.js";
import { createCronRuntime } from "../../../src/cron/runtime/CronRuntime.js";
import { resolveCronPaths } from "../../../src/cron/storage/CronPaths.js";
import { CronTaskStore } from "../../../src/cron/storage/CronTaskStore.js";
import { makeTask } from "../helpers.js";

const FIXED_NOW = new Date("2026-08-05T00:00:00.000Z");

const CONFIG: CronConfig = {
  enabled: true,
  timezone: "UTC",
  maxConcurrentRuns: 1,
  runTimeoutMinutes: 60,
};

const PROJECT_KEY = "/project/general";

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sati-cron-update-"));
  const store = new CronTaskStore(resolveCronPaths({ pilotHome: dir, projectKey: PROJECT_KEY }));
  const runtime = createCronRuntime({
    config: CONFIG,
    pilotHome: dir,
    projectKey: PROJECT_KEY,
    now: () => FIXED_NOW,
    uuid: () => "fixed-uuid",
    store,
    skipToolCreation: true,
  });
  return { runtime, store };
}

describe("CronRuntime.updateTask", () => {
  it("updates message and cron expression, keeps identity, recomputes nextRunAt", async () => {
    const { runtime, store } = makeRuntime();

    const existing = makeTask({
      taskId: "t1",
      message: "旧任务",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      timezone: "UTC",
      nextRunAt: "2026-08-06T09:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await store.putTask(existing);

    const result = await runtime.updateTask({
      taskId: "t1",
      message: "新任务",
      schedule: { type: "cron", expression: "30 8 * * 1-5", timezone: "UTC" },
      timezone: "UTC",
    });

    assert.equal(result.task.taskId, "t1");
    assert.equal(result.task.message, "新任务");
    assert.deepEqual(result.task.schedule, { type: "cron", expression: "30 8 * * 1-5", timezone: "UTC" });
    // FIXED_NOW = 2026-08-05T00:00:00Z，下一个工作日 08:30 为当天
    assert.equal(result.task.nextRunAt, "2026-08-05T08:30:00.000Z");
    assert.equal(result.task.sessionKey, existing.sessionKey);
    assert.equal(result.task.channelKey, existing.channelKey);
    assert.equal(result.task.createdAt, "2026-08-01T00:00:00.000Z");
    assert.equal(result.task.updatedAt, FIXED_NOW.toISOString());
    assert.equal(result.task.status, "scheduled");

    const persisted = await store.listTasks();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.message, "新任务");
    assert.equal(persisted[0]!.nextRunAt, "2026-08-05T08:30:00.000Z");
  });

  it("updates a one-time task runAt", async () => {
    const { runtime, store } = makeRuntime();

    const existing = makeTask({
      taskId: "t-once",
      schedule: { type: "once", runAt: "2026-08-06T00:00:00.000Z" },
      nextRunAt: "2026-08-06T00:00:00.000Z",
    });
    await store.putTask(existing);

    const result = await runtime.updateTask({
      taskId: "t-once",
      message: existing.message,
      schedule: { type: "once", runAt: "2026-08-07T10:00:00.000Z" },
    });

    assert.equal(result.task.schedule.type, "once");
    assert.equal(result.task.nextRunAt, "2026-08-07T10:00:00.000Z");
  });

  it("rejects updating a running task", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-running", status: "running" }));

    await assert.rejects(
      runtime.updateTask({
        taskId: "t-running",
        message: "改不了",
        schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      }),
      /running/,
    );
  });

  it("rejects updating a task that does not exist", async () => {
    const { runtime } = makeRuntime();

    await assert.rejects(
      runtime.updateTask({
        taskId: "missing",
        message: "无",
        schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      }),
      /not found/,
    );
  });

  it("rejects an invalid cron expression", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-bad" }));

    await assert.rejects(
      runtime.updateTask({
        taskId: "t-bad",
        message: "坏表达式",
        schedule: { type: "cron", expression: "not-a-cron", timezone: "UTC" },
      }),
      /does not produce a valid future run time/,
    );
  });

  it("rejects a one-time task scheduled in the past", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-past" }));

    await assert.rejects(
      runtime.updateTask({
        taskId: "t-past",
        message: "过去时间",
        schedule: { type: "once", runAt: "2026-01-01T00:00:00.000Z" },
      }),
      /must be scheduled in the future/,
    );
  });
});
