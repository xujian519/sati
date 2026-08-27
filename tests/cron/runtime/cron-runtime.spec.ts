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
      projectKey: PROJECT_KEY,
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
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      message: "新任务",
      schedule: { type: "cron", expression: "30 8 * * 1-5", timezone: "UTC" },
      timezone: "UTC",
    });

    assert.equal(result.updated, true);
    assert.ok(result.updated);
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
      projectKey: PROJECT_KEY,
      schedule: { type: "once", runAt: "2026-08-06T00:00:00.000Z" },
      nextRunAt: "2026-08-06T00:00:00.000Z",
    });
    await store.putTask(existing);

    const result = await runtime.updateTask({
      taskId: "t-once",
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      message: existing.message,
      schedule: { type: "once", runAt: "2026-08-07T10:00:00.000Z" },
    });

    assert.equal(result.updated, true);
    assert.ok(result.updated);
    assert.equal(result.task.schedule.type, "once");
    assert.equal(result.task.nextRunAt, "2026-08-07T10:00:00.000Z");
  });

  it("rejects updating a running task", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-running", projectKey: PROJECT_KEY, status: "running" }));

    const result = await runtime.updateTask({
      taskId: "t-running",
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      message: "改不了",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });
    assert.deepEqual(result, { updated: false, reason: "running" });
  });

  it("rejects updating a task that does not exist", async () => {
    const { runtime } = makeRuntime();

    const result = await runtime.updateTask({
      taskId: "missing",
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      message: "无",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });
    assert.deepEqual(result, { updated: false, reason: "not_found" });
  });

  it("rejects an invalid cron expression", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-bad", projectKey: PROJECT_KEY }));

    await assert.rejects(
      runtime.updateTask({
        taskId: "t-bad",
        projectKey: PROJECT_KEY,
        expectedRevision: 0,
        message: "坏表达式",
        schedule: { type: "cron", expression: "not-a-cron", timezone: "UTC" },
      }),
      /does not produce a valid future run time/,
    );
  });

  it("rejects a one-time task scheduled in the past", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-past", projectKey: PROJECT_KEY }));

    await assert.rejects(
      runtime.updateTask({
        taskId: "t-past",
        projectKey: PROJECT_KEY,
        expectedRevision: 0,
        message: "过去时间",
        schedule: { type: "once", runAt: "2026-01-01T00:00:00.000Z" },
      }),
      /must be scheduled in the future/,
    );
  });

  it("rejects a stale expectedRevision with conflict, then accepts the latest revision", async () => {
    const { runtime, store } = makeRuntime();

    await store.putTask(makeTask({ taskId: "t-edit", projectKey: PROJECT_KEY }));

    const first = await runtime.updateTask({
      taskId: "t-edit",
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      message: "v1",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });
    assert.equal(first.updated, true);

    // 用已过期的 revision 再更新 → conflict
    const stale = await runtime.updateTask({
      taskId: "t-edit",
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      message: "v2",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });
    assert.deepEqual(stale, { updated: false, reason: "conflict" });

    // 最新 revision 可更新
    const ok = await runtime.updateTask({
      taskId: "t-edit",
      projectKey: PROJECT_KEY,
      expectedRevision: 1,
      message: "v2",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });
    assert.equal(ok.updated, true);
    assert.ok(ok.updated);
    assert.equal(ok.task.message, "v2");
  });
});

describe("CronRuntime.runTaskNow", () => {
  it("run-now 孵化的一次性任务使用注入时钟的 runAt", async () => {
    const { runtime, store } = makeRuntime();
    const existing = makeTask({
      taskId: "t1",
      projectKey: PROJECT_KEY,
      message: "周期任务",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      timezone: "UTC",
      nextRunAt: "2026-08-06T09:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await store.putTask(existing);

    const result = await runtime.runTaskNow({ taskId: "t1" });
    assert.equal(result.started, true);
    assert.ok(result.taskId !== undefined && result.taskId !== "t1");

    const spawned = (await store.listTasks()).find(task => task.taskId === result.taskId);
    assert.ok(spawned);
    assert.equal(spawned.schedule.type, "once");
    // 修复前此处是真实墙上时钟（new Date()），fake-clock 下行为漂移。
    assert.equal(spawned.schedule.type === "once" ? spawned.schedule.runAt : undefined, FIXED_NOW.toISOString());
    assert.equal(spawned.message, "周期任务");

    // 原任务保持不变（计划照旧）。
    const original = (await store.listTasks()).find(task => task.taskId === "t1");
    assert.ok(original);
    assert.equal(original.schedule.type, "cron");
  });

  it("任务不存在与运行中分别返回 not_found / already_running", async () => {
    const { runtime, store } = makeRuntime();
    assert.deepEqual(await runtime.runTaskNow({ taskId: "missing" }), { started: false, reason: "not_found" });

    const running = makeTask({
      taskId: "t-run",
      projectKey: PROJECT_KEY,
      message: "跑着的任务",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      timezone: "UTC",
      nextRunAt: "2026-08-06T09:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      status: "running",
    });
    await store.putTask(running);
    const result = await runtime.runTaskNow({ taskId: "t-run" });
    assert.equal(result.started, false);
    assert.equal(result.reason, "already_running");
  });
});
