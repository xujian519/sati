import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CronConfig } from "../../../src/cron/config/parseCronConfig.js";
import type { CronTask } from "../../../src/cron/protocol/types.js";
import type { CronFire } from "../../../src/cron/runtime/CronFire.js";
import { CronScheduler } from "../../../src/cron/runtime/CronScheduler.js";
import { resolveCronPaths } from "../../../src/cron/storage/CronPaths.js";
import { CronTaskStore } from "../../../src/cron/storage/CronTaskStore.js";
import { makeTask } from "../helpers.js";

const CONFIG: CronConfig = { enabled: true, timezone: "UTC", maxConcurrentRuns: 1, runTimeoutMinutes: 60 };

const tempDirs: string[] = [];
const schedulers: CronScheduler[] = [];

afterEach(async () => {
  while (schedulers.length > 0) {
    await schedulers
      .pop()!
      .stop()
      .catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeStore(): CronTaskStore {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-cron-migration-"));
  tempDirs.push(pilotHome);
  return new CronTaskStore(resolveCronPaths({ pilotHome, projectKey: "/tmp/projects/cron-migration" }));
}

function makeScheduler(options: {
  store: CronTaskStore;
  now: () => Date;
  config?: CronConfig;
  fire?: CronFire;
  activeRunCount?: () => number;
}): CronScheduler {
  const scheduler = new CronScheduler({
    config: options.config ?? CONFIG,
    store: options.store,
    fire: options.fire ?? ({ runTask: async () => undefined } as unknown as CronFire),
    uuid: () => "run-1",
    now: options.now,
    activeRunCount: options.activeRunCount ?? (() => 0),
  });
  schedulers.push(scheduler);
  return scheduler;
}

async function readTask(store: CronTaskStore, taskId: string): Promise<CronTask | undefined> {
  return (await store.listTasks()).find(task => task.taskId === taskId);
}

describe("CronScheduler v2 → v3 计算版本迁移", () => {
  it("刷新旧缓存、保留逾期触发、放行一次性任务", async () => {
    const store = makeStore();
    const now = new Date("2026-06-02T00:00:00.000Z");
    const scheduler = makeScheduler({ store, now: () => now });
    const restarted = makeScheduler({ store, now: () => now });

    const cacheCases = [
      { taskId: "full-weekday-range", expression: "0 9 1 * 0-6", nextRunAt: "2026-07-01T09:00:00.000Z" },
      { taskId: "full-month-day-range", expression: "0 9 1-31 * 1", nextRunAt: "2026-06-08T09:00:00.000Z" },
      { taskId: "missing-cache", expression: "0 9 * * *", nextRunAt: undefined },
      { taskId: "invalid-cache", expression: "0 9 * * *", nextRunAt: "invalid" },
    ];
    for (const { taskId, expression, nextRunAt } of cacheCases) {
      await store.putTask(makeTask({ taskId, schedule: { type: "cron", expression, timezone: "UTC" }, nextRunAt }));
    }
    await store.putTask(
      makeTask({
        taskId: "combined",
        schedule: { type: "cron", expression: "0 9 1 * 1", timezone: "UTC" },
        nextRunAt: "2027-02-01T09:00:00.000Z",
      }),
    );
    await store.putTask(
      makeTask({
        taskId: "overdue",
        schedule: { type: "cron", expression: "0 9 1 * 1", timezone: "UTC" },
        nextRunAt: "2026-06-01T09:00:00.000Z",
      }),
    );
    await store.putTask(
      makeTask({
        taskId: "once",
        schedule: { type: "once", runAt: "2026-06-03T09:00:00.000Z" },
        nextRunAt: "2026-06-03T09:00:00.000Z",
        scheduleComputationVersion: undefined,
      }),
    );

    await scheduler.start();

    const combined = await readTask(store, "combined");
    // OR 语义把「既是 1 号又是周一」的 2027-02-01 提前到 2026-06-08（周一）。
    assert.equal(combined?.nextRunAt, "2026-06-08T09:00:00.000Z");
    assert.equal(combined?.scheduleComputationVersion, 3);
    assert.equal(combined?.revision, 1);

    // 逾期的 v2 触发点原样保留，不因迁移被推后。
    const overdue = await readTask(store, "overdue");
    assert.equal(overdue?.nextRunAt, "2026-06-01T09:00:00.000Z");
    assert.equal(overdue?.scheduleComputationVersion, 3);

    // 一次性任务不参与迁移。
    const once = await readTask(store, "once");
    assert.equal(once?.nextRunAt, "2026-06-03T09:00:00.000Z");
    assert.equal(once?.revision, 0);
    assert.equal(once?.scheduleComputationVersion, undefined);

    for (const { taskId } of cacheCases) {
      const migrated = await readTask(store, taskId);
      assert.equal(migrated?.nextRunAt, "2026-06-02T09:00:00.000Z", taskId);
      assert.equal(migrated?.scheduleComputationVersion, 3, taskId);
    }

    // 二次启动复用已迁移的缓存，不再改写任务。
    await restarted.start();
    assert.deepEqual(await readTask(store, "combined"), combined);
    assert.deepEqual(await readTask(store, "overdue"), overdue);
    assert.deepEqual(await readTask(store, "once"), once);
  });

  for (const expression of ["0 9 * * *", "0 9 1 * 1"]) {
    it(`迁移时保留被并发上限推迟的 v2 触发点（${expression}）`, async () => {
      const store = makeStore();
      let now = new Date("2026-06-01T09:00:00.000Z");
      let activeRunCount = 1;
      const fired: CronTask[] = [];
      const make = () =>
        makeScheduler({
          store,
          now: () => now,
          fire: { runTask: async (task: CronTask) => void fired.push(task) } as unknown as CronFire,
          activeRunCount: () => activeRunCount,
        });
      const beforeUpgrade = make();
      const upgraded = make();
      const restarted = make();

      await store.putTask(
        makeTask({
          taskId: "task-1",
          schedule: { type: "cron", expression, timezone: "UTC" },
          nextRunAt: now.toISOString(),
        }),
      );
      // v2 调度器在升级前把已到期任务推迟 15s（并发上限）。
      await beforeUpgrade.runTickOnce();
      await beforeUpgrade.stop();
      assert.equal((await readTask(store, "task-1"))?.nextRunAt, "2026-06-01T09:00:15.000Z");

      now = new Date("2026-06-01T09:00:05.000Z");
      activeRunCount = 0;
      await upgraded.start();

      const migrated = await readTask(store, "task-1");
      // 未来的缓存可能是被推迟的逾期触发，迁移不得把它推后。
      assert.equal(migrated?.nextRunAt, "2026-06-01T09:00:15.000Z");
      assert.equal(migrated?.scheduleComputationVersion, 3);
      assert.equal(migrated?.revision, 2);

      await restarted.start();
      assert.deepEqual(await readTask(store, "task-1"), migrated);
      await restarted.runTickOnce();
      assert.equal(fired.length, 0);

      now = new Date("2026-06-01T09:00:15.000Z");
      await restarted.runTickOnce();
      assert.equal(fired.length, 1);
      assert.equal(fired[0]!.taskId, "task-1");
    });
  }

  it("日语义未变的 v2 任务直接复用缓存，不做逐分钟搜索", async t => {
    const store = makeStore();
    const now = new Date("2026-01-02T00:00:00.000Z");
    const cases = [
      { expression: "0 9 1 1 *", nextRunAt: "2027-01-01T09:00:00.000Z" },
      { expression: "0 9 1 1 */1", nextRunAt: "2027-01-01T09:00:00.000Z" },
      { expression: "0 9 * 1 1", nextRunAt: "2026-01-05T09:00:00.000Z" },
      { expression: "0 9 */2 1 1", nextRunAt: "2026-01-05T09:00:00.000Z" },
    ];
    for (const { expression, nextRunAt } of cases) {
      await store.putTask(
        makeTask({ taskId: expression, schedule: { type: "cron", expression, timezone: "UTC" }, nextRunAt }),
      );
    }
    // 确定性性能护栏：任一逐分钟匹配器被调用即失败。
    const calendarSearch = t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", () => {
      throw new Error("日语义未变的 v2 任务必须复用缓存的下一次触发时间");
    });

    const scheduler = makeScheduler({ store, now: () => now });
    await scheduler.start();
    assert.equal(calendarSearch.mock.callCount(), 0);

    for (const { expression, nextRunAt } of cases) {
      const migrated = await readTask(store, expression);
      assert.equal(migrated?.nextRunAt, nextRunAt, expression);
      assert.equal(migrated?.scheduleComputationVersion, 3, expression);
      assert.equal(migrated?.revision, 1, expression);
    }
  });
});
