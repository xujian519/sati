import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CronTaskStore, resolveCronPaths, type CronTask } from "../../src/cron/index.js";

function makeStore(): { store: CronTaskStore; cleanup: () => void } {
  const politHome = mkdtempSync(join(tmpdir(), "politdeck-cron-store-"));
  const paths = resolveCronPaths({ politHome, projectKey: "/tmp/projects/sample" });
  return {
    store: new CronTaskStore(paths),
    cleanup: () => rmSync(politHome, { recursive: true, force: true }),
  };
}

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    schemaVersion: 1,
    taskId: "task_1",
    message: "Summarize the latest status.",
    schedule: { type: "once", runAt: "2026-05-09T12:00:00.000Z" },
    status: "scheduled",
    sessionKey: "cli:s_1",
    channelKey: "cli",
    projectKey: "/tmp/projects/sample",
    createdAt: "2026-05-09T11:00:00.000Z",
    updatedAt: "2026-05-09T11:00:00.000Z",
    nextRunAt: "2026-05-09T12:00:00.000Z",
    ...overrides,
  };
}

test("CronTaskStore persists task CRUD", async () => {
  const { store, cleanup } = makeStore();
  try {
    await store.putTask(makeTask());
    assert.equal((await store.listTasks()).length, 1);
    assert.equal((await store.getTask("task_1"))?.message, "Summarize the latest status.");

    const updated = await store.updateTask("task_1", (task) => ({
      ...task,
      status: "running",
      updatedAt: "2026-05-09T12:00:00.000Z",
    }));
    assert.equal(updated?.status, "running");
    assert.equal((await store.getTask("task_1"))?.status, "running");

    assert.equal(await store.deleteTask("task_1"), true);
    assert.deepEqual(await store.listTasks(), []);
  } finally {
    cleanup();
  }
});

test("CronTaskStore records run history newest first", async () => {
  const { store, cleanup } = makeStore();
  try {
    await store.appendRun({
      schemaVersion: 1,
      runId: "run_1",
      taskId: "task_1",
      sessionKey: "cli:s_1",
      startedAt: "2026-05-09T12:00:00.000Z",
      finishedAt: "2026-05-09T12:01:00.000Z",
      outcome: "completed",
    });
    await store.appendRun({
      schemaVersion: 1,
      runId: "run_2",
      taskId: "task_1",
      sessionKey: "cli:s_1",
      startedAt: "2026-05-09T13:00:00.000Z",
      finishedAt: "2026-05-09T13:01:00.000Z",
      outcome: "stopped",
    });
    const runs = await store.listRuns(2);
    assert.deepEqual(runs.map((run) => run.runId), ["run_2", "run_1"]);
  } finally {
    cleanup();
  }
});
