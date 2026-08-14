import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CronConfig } from "../../../src/cron/config/parseCronConfig.js";
import type { CronTask } from "../../../src/cron/protocol/types.js";
import type { CronFire } from "../../../src/cron/runtime/CronFire.js";
import {
  CronScheduler,
  computeCronDelayMs,
  type CronSchedulerDependencies,
} from "../../../src/cron/runtime/CronScheduler.js";
import type { CronTaskStore } from "../../../src/cron/storage/CronTaskStore.js";
import { makeTask } from "../helpers.js";

const FIXED_NOW = new Date("2026-08-05T00:00:00.000Z");

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type FakeStore = {
  listCalls: number;
  putCalls: CronTask[];
  deleteCalls: string[];
  updateCalls: CronTask[];
  tasks: CronTask[];
};

function makeFakeStore(initial: CronTask[] = []): FakeStore & {
  listTasks: () => Promise<CronTask[]>;
  putTask: (task: CronTask) => Promise<void>;
  updateTask: (taskId: string, update: (task: CronTask) => CronTask | undefined) => Promise<CronTask | undefined>;
  deleteTask: (taskId: string) => Promise<boolean>;
} {
  const store = {
    listCalls: 0,
    putCalls: [] as CronTask[],
    deleteCalls: [] as string[],
    updateCalls: [] as CronTask[],
    tasks: [...initial],
    async listTasks(): Promise<CronTask[]> {
      store.listCalls += 1;
      return store.tasks;
    },
    async putTask(task: CronTask): Promise<void> {
      store.tasks = [...store.tasks.filter(t => t.taskId !== task.taskId), task];
      store.putCalls.push(task);
    },
    async updateTask(taskId: string, update: (task: CronTask) => CronTask | undefined): Promise<CronTask | undefined> {
      let updated: CronTask | undefined;
      store.tasks = store.tasks.flatMap(task => {
        if (task.taskId !== taskId) return [task];
        updated = update(task);
        return updated ? [updated] : [];
      });
      if (updated) store.updateCalls.push(updated);
      return updated;
    },
    async deleteTask(taskId: string): Promise<boolean> {
      store.tasks = store.tasks.filter(t => t.taskId !== taskId);
      store.deleteCalls.push(taskId);
      return true;
    },
  };
  return store;
}

function makeFakeFire(impl?: (task: CronTask, runId: string) => Promise<void>): {
  fire: CronFire;
  calls: Array<{ task: CronTask; runId: string }>;
} {
  const calls: Array<{ task: CronTask; runId: string }> = [];
  const fire = {
    async runTask(task: CronTask, runId: string): Promise<void> {
      calls.push({ task, runId });
      await impl?.(task, runId);
    },
  } as unknown as CronFire;
  return { fire, calls };
}

const createdSchedulers: CronScheduler[] = [];

afterEach(async () => {
  while (createdSchedulers.length > 0) {
    await createdSchedulers
      .pop()!
      .stop()
      .catch(() => undefined);
  }
});

function makeScheduler(
  overrides: {
    config?: CronConfig;
    store?: ReturnType<typeof makeFakeStore>;
    fire?: CronFire;
    uuid?: () => string;
    now?: () => Date;
    activeRunCount?: () => number;
    logger?: CronSchedulerDependencies["logger"];
  } = {},
): CronScheduler {
  const scheduler = new CronScheduler({
    config: overrides.config ?? { enabled: true, timezone: "UTC", maxConcurrentRuns: 1, runTimeoutMinutes: 60 },
    store: (overrides.store ?? makeFakeStore()) as unknown as CronTaskStore,
    fire: overrides.fire ?? makeFakeFire().fire,
    uuid: overrides.uuid ?? (() => "run-1"),
    now: overrides.now ?? (() => FIXED_NOW),
    activeRunCount: overrides.activeRunCount ?? (() => 0),
    logger: overrides.logger,
  });
  createdSchedulers.push(scheduler);
  return scheduler;
}

/**
 * 替换 globalThis.setTimeout 以记录调度器请求的唤醒延迟；invokeFirst 为 true
 * 时允许第一个定时器真正触发（驱动一次 tick → 再次 scheduleNextTick），后续
 * 定时器只记录不触发，避免 60s 空闲回退把测试挂住。
 */
function installTimerCapture(delays: number[], invokeFirst = false): () => void {
  const originalSetTimeout = globalThis.setTimeout;
  let invoked = false;
  const fake = ((callback: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    if (invokeFirst && !invoked) {
      invoked = true;
      return originalSetTimeout(() => callback(), 0);
    }
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = fake;
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// isDue 边界
// ---------------------------------------------------------------------------

describe("CronScheduler isDue 边界", () => {
  it("nextRunAt 缺失的任务不触发", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: undefined })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 0);
  });

  it("nextRunAt 非法的任务不触发", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "not-a-date" })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 0);
  });

  it("running 状态的任务即使到期也跳过", async () => {
    const store = makeFakeStore([
      makeTask({ taskId: "running-1", status: "running", nextRunAt: "2026-08-04T00:00:00.000Z" }),
      makeTask({ taskId: "due-1", nextRunAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.task.taskId, "due-1");
  });

  it("未到期的任务不触发", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "2026-08-06T00:00:00.000Z" })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 0);
  });

  it("nextRunAt 恰好等于 now 时触发（<= 边界）", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: FIXED_NOW.toISOString() })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 1);
  });

  it("到期任务触发 fire.runTask（runId 来自 uuid）", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "2026-08-04T00:00:00.000Z" })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire, uuid: () => "run-42" });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.runId, "run-42");
    assert.equal(calls[0]!.task.taskId, "t1");
  });

  it("多个到期任务全部触发", async () => {
    const store = makeFakeStore([
      makeTask({ taskId: "a", nextRunAt: "2026-08-04T00:00:00.000Z" }),
      makeTask({ taskId: "b", nextRunAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.task.taskId).sort(), ["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 并发上限与延迟重试
// ---------------------------------------------------------------------------

describe("CronScheduler 并发上限", () => {
  it("maxConcurrentRuns 超限：delayTask 把 nextRunAt 延后 15s，不触发 fire", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "2026-08-04T00:00:00.000Z" })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire, activeRunCount: () => 1 });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 0);
    assert.equal(store.updateCalls.length, 1);
    const updated = store.updateCalls[0]!;
    assert.equal(updated.taskId, "t1");
    assert.equal(updated.nextRunAt, new Date(FIXED_NOW.getTime() + 15_000).toISOString());
    assert.equal(updated.updatedAt, FIXED_NOW.toISOString());
  });

  it("并发未超限时正常触发", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "2026-08-04T00:00:00.000Z" })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire, activeRunCount: () => 0 });
    await scheduler.runTickOnce();
    assert.equal(calls.length, 1);
    assert.equal(store.putCalls.length, 0);
  });

  it("fire.runTask 抛错经 logger.warn 记录且不中断 tick", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "2026-08-04T00:00:00.000Z" })]);
    const { fire } = makeFakeFire(async () => {
      throw new Error("gateway down");
    });
    const warns: Array<{ message: string }> = [];
    const scheduler = makeScheduler({ store, fire, logger: { warn: (message: string) => warns.push({ message }) } });
    await scheduler.runTickOnce();
    await waitFor(() => warns.length > 0);
    assert.equal(warns[0]!.message, "cron fire failed");
  });
});

// ---------------------------------------------------------------------------
// computeCronDelayMs（纯函数，直接喂字面量）
// ---------------------------------------------------------------------------

describe("computeCronDelayMs", () => {
  const NOW = FIXED_NOW.getTime();

  it("无任务时空闲回退 60s", () => {
    assert.equal(computeCronDelayMs([], NOW), 60_000);
  });

  it("按最早 nextRunAt 计算唤醒间隔", () => {
    const tasks = [
      makeTask({ taskId: "t1", nextRunAt: new Date(NOW + 30_000).toISOString() }),
      makeTask({ taskId: "t2", nextRunAt: new Date(NOW + 60_000).toISOString() }),
    ];
    assert.equal(computeCronDelayMs(tasks, NOW), 30_000);
  });

  it("nextRunAt 超过 60s 时钳制到 60s 上限", () => {
    const tasks = [makeTask({ nextRunAt: new Date(NOW + 5 * 60_000).toISOString() })];
    assert.equal(computeCronDelayMs(tasks, NOW), 60_000);
  });

  it("已过期任务返回 0（立即唤醒）", () => {
    const tasks = [makeTask({ nextRunAt: new Date(NOW - 1000).toISOString() })];
    assert.equal(computeCronDelayMs(tasks, NOW), 0);
  });

  it("running/无 nextRunAt/非法日期任务一律跳过并回退 60s", () => {
    const tasks = [
      makeTask({ taskId: "t1", status: "running", nextRunAt: new Date(NOW + 10_000).toISOString() }),
      makeTask({ taskId: "t2", nextRunAt: undefined }),
      makeTask({ taskId: "t3", nextRunAt: "not-a-date" }),
    ];
    assert.equal(computeCronDelayMs(tasks, NOW), 60_000);
  });

  it("跳过 running 任务后取剩余最早时间", () => {
    const tasks = [
      makeTask({ taskId: "t1", status: "running", nextRunAt: new Date(NOW + 5_000).toISOString() }),
      makeTask({ taskId: "t2", nextRunAt: new Date(NOW + 45_000).toISOString() }),
    ];
    assert.equal(computeCronDelayMs(tasks, NOW), 45_000);
  });
});

// ---------------------------------------------------------------------------
// start/stop/stopped 状态机
// ---------------------------------------------------------------------------

describe("CronScheduler 生命周期", () => {
  it("enabled=false 时 start 为 no-op（不读任务、不调度）", async () => {
    const delays: number[] = [];
    const restore = installTimerCapture(delays);
    try {
      const store = makeFakeStore();
      const scheduler = makeScheduler({
        store,
        config: { enabled: false, timezone: "UTC", maxConcurrentRuns: 1, runTimeoutMinutes: 60 },
      });
      await scheduler.start();
      assert.equal(store.listCalls, 0);
      assert.equal(delays.length, 0);
    } finally {
      restore();
    }
  });

  it("start 幂等：重复调用不重复读任务", async () => {
    const delays: number[] = [];
    const restore = installTimerCapture(delays);
    try {
      const store = makeFakeStore();
      const scheduler = makeScheduler({ store });
      await scheduler.start();
      await scheduler.start();
      assert.equal(store.listCalls, 1);
      assert.equal(delays.length, 1);
      await scheduler.stop();
    } finally {
      restore();
    }
  });

  it("stop 后 start 不再启动（stopped 闩锁）", async () => {
    const delays: number[] = [];
    const restore = installTimerCapture(delays);
    try {
      const store = makeFakeStore();
      const scheduler = makeScheduler({ store });
      await scheduler.start();
      await scheduler.stop();
      await scheduler.start();
      assert.equal(store.listCalls, 1);
      await scheduler.stop();
    } finally {
      restore();
    }
  });

  it("stopped 后 poke 不再调度新的定时器", async () => {
    const delays: number[] = [];
    const restore = installTimerCapture(delays);
    try {
      const scheduler = makeScheduler();
      await scheduler.start();
      assert.equal(delays.length, 1);
      await scheduler.stop();
      scheduler.poke();
      assert.equal(delays.length, 1);
    } finally {
      restore();
    }
  });

  it("stop 后 runTickOnce 仍可作为测试入口直接运行 tick", async () => {
    const store = makeFakeStore([makeTask({ nextRunAt: "2026-08-04T00:00:00.000Z" })]);
    const { fire, calls } = makeFakeFire();
    const scheduler = makeScheduler({ store, fire });
    await scheduler.start();
    await scheduler.stop();
    await scheduler.runTickOnce();
    assert.equal(calls.length, 1);
  });
});
