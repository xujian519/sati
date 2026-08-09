import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../../../src/always-on/config/parseAlwaysOnConfig.js";
import { AlwaysOnError } from "../../../src/always-on/protocol/errors.js";
import type {
  AlwaysOnDiscoveryState,
  DiscoveryFireResult,
  WorkCycleRecord,
} from "../../../src/always-on/protocol/types.js";
import { ChannelLeaseRegistry } from "../../../src/always-on/runtime/ChannelLeaseRegistry.js";
import { DiscoveryFire } from "../../../src/always-on/runtime/DiscoveryFire.js";
import {
  DiscoveryScheduler,
  type DiscoverySchedulerDependencies,
} from "../../../src/always-on/runtime/DiscoveryScheduler.js";
import { resolveAlwaysOnPaths, type AlwaysOnPaths } from "../../../src/always-on/storage/AlwaysOnPaths.js";
import type { DiscoveryStateStore } from "../../../src/always-on/storage/DiscoveryStateStore.js";
import type { WorkCycleStore } from "../../../src/always-on/storage/WorkCycleStore.js";

const NOW = new Date("2026-08-03T10:00:00.000Z");

const tempDirs: string[] = [];

type SchedulerCalls = {
  markFireStarted: Array<{ runId: string; now: Date }>;
  clearDormantCount: number;
  fireRunCalls: Array<{ runId: string; startedAt: Date }>;
  infos: string[];
  warns: string[];
};

function makeConfig(projectKey: string): AlwaysOnConfig {
  const base = defaultAlwaysOnConfig();
  return {
    ...base,
    enabled: true,
    trigger: {
      ...base.trigger,
      enabled: true,
      cooldownMinutes: 0,
      dailyBudget: 4,
      recentUserMsgMinutes: 5,
    },
    dormancy: { ...base.dormancy, enabled: false },
    projects: { [projectKey]: { enabled: true } },
  };
}

function defaultState(): AlwaysOnDiscoveryState {
  return {
    schemaVersion: 1,
    todayKey: "2026-08-03",
    todayRunCount: 0,
    consecutiveFailures: 0,
  };
}

function makeCycle(overrides: Partial<WorkCycleRecord> = {}): WorkCycleRecord {
  return {
    id: "cyc-1",
    projectKey: "/tmp/project",
    status: "active",
    workspace: { strategy: "git-worktree", cwd: "/tmp/workspace", metadata: {} },
    planIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    createdByRunId: "run-0",
    ...overrides,
  };
}

function setup(
  overrides: {
    config?: AlwaysOnConfig;
    state?: AlwaysOnDiscoveryState;
    cycle?: WorkCycleRecord | undefined;
    isSessionInFlight?: () => boolean;
    uuid?: () => string;
    fireRun?: (input: { runId: string; startedAt: Date }) => Promise<DiscoveryFireResult>;
    /** 在 tick 第二次调用 now() 时触发（位于 gate 之后、acquire 之前）。 */
    onSecondNow?: () => void;
  } = {},
): { scheduler: DiscoveryScheduler; paths: AlwaysOnPaths; calls: SchedulerCalls } {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-aon-scheduler-"));
  tempDirs.push(pilotHome);
  const projectKey = mkdtempSync(join(tmpdir(), "sati-aon-project-"));
  tempDirs.push(projectKey);
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey });

  const calls: SchedulerCalls = { markFireStarted: [], clearDormantCount: 0, fireRunCalls: [], infos: [], warns: [] };
  const state = overrides.state ?? defaultState();
  const cycle = overrides.cycle;

  let nowCalls = 0;
  const nowFn = (): Date => {
    nowCalls += 1;
    if (nowCalls === 2) {
      overrides.onSecondNow?.();
    }
    return NOW;
  };

  const stateStore = {
    read: async (): Promise<AlwaysOnDiscoveryState> => state,
    markFireStarted: async (runId: string, firedNow: Date): Promise<AlwaysOnDiscoveryState> => {
      calls.markFireStarted.push({ runId, now: firedNow });
      return state;
    },
    clearDormant: async (): Promise<AlwaysOnDiscoveryState> => {
      calls.clearDormantCount += 1;
      return state;
    },
  } as unknown as DiscoveryStateStore;

  const cycleStore = {
    getRecord: async (): Promise<WorkCycleRecord | undefined> => cycle,
  } as unknown as WorkCycleStore;

  const fire = {
    run: async (input: { runId: string; startedAt: Date }): Promise<DiscoveryFireResult> => {
      assert.ok(existsSync(paths.discoveryLockFile), "fire.run 执行期间锁文件必须存在");
      calls.fireRunCalls.push(input);
      return (
        overrides.fireRun?.(input) ?? {
          outcome: "no_plan",
          runId: input.runId,
          startedAt: input.startedAt.toISOString(),
          finishedAt: input.startedAt.toISOString(),
        }
      );
    },
  } as unknown as DiscoveryFire;

  const config = overrides.config
    ? { ...overrides.config, projects: { [projectKey]: { enabled: true } } }
    : makeConfig(projectKey);

  const deps: DiscoverySchedulerDependencies = {
    config,
    projectKey,
    paths,
    stateStore,
    cycleStore,
    leases: new ChannelLeaseRegistry(),
    fire,
    uuid: overrides.uuid ?? (() => "run-1"),
    now: nowFn,
    logger: {
      info: (message: string) => {
        calls.infos.push(message);
      },
      warn: (message: string) => {
        calls.warns.push(message);
      },
    },
    isSessionInFlight: overrides.isSessionInFlight ?? (() => false),
  };

  return { scheduler: new DiscoveryScheduler(deps), paths, calls };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("DiscoveryScheduler.runTickOnce", () => {
  it("gate 不通过（全局禁用）→ blocked，不触发 fire、不加锁", async () => {
    const { scheduler, calls, paths } = setup({ config: { ...makeConfig("/tmp/none"), enabled: false } });
    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "disabled" });
    assert.deepEqual(calls.fireRunCalls, []);
    assert.deepEqual(calls.markFireStarted, []);
    assert.ok(!existsSync(paths.discoveryLockFile));
  });

  it("gate 不通过（会话执行中）→ blocked agent_busy", async () => {
    const { scheduler, calls } = setup({ isSessionInFlight: () => true });
    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "agent_busy" });
    assert.deepEqual(calls.fireRunCalls, []);
  });

  it("gate 不通过（今日预算用尽）→ blocked daily_budget", async () => {
    const { scheduler, calls } = setup({ state: { ...defaultState(), todayRunCount: 4 } });
    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "daily_budget" });
    assert.deepEqual(calls.fireRunCalls, []);
  });

  it("全流程通过：gate → 加锁 → markFireStarted → clearDormant → fire.run → 释放锁", async () => {
    const { scheduler, paths, calls } = setup();

    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "fired" });
    // runId 来自注入的 uuid，startedAt 来自注入的 now
    assert.deepEqual(calls.markFireStarted, [{ runId: "run-1", now: NOW }]);
    assert.equal(calls.clearDormantCount, 1);
    assert.deepEqual(calls.fireRunCalls, [{ runId: "run-1", startedAt: NOW }]);
    assert.ok(calls.infos.includes("always-on fire complete"));
    // finally 中释放锁
    assert.ok(!existsSync(paths.discoveryLockFile));
  });

  it("锁文件在 acquire 前出现（EEXIST）→ blocked lock_busy，fire 不触发", async () => {
    const { scheduler, paths, calls } = setup({
      onSecondNow: () => {
        mkdirSync(join(paths.projectDir, "locks"), { recursive: true });
        writeFileSync(paths.discoveryLockFile, JSON.stringify({ pid: 1, runId: "other", startedAt: "x" }), "utf8");
      },
    });

    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "lock_busy" });
    assert.deepEqual(calls.fireRunCalls, []);
    assert.deepEqual(calls.markFireStarted, [], "加锁失败后不得 markFireStarted");
  });

  it("gate 层检测到已有锁文件 → blocked lock_busy", async () => {
    const { scheduler, paths, calls } = setup();
    mkdirSync(join(paths.projectDir, "locks"), { recursive: true });
    writeFileSync(paths.discoveryLockFile, JSON.stringify({ pid: 1, runId: "x", startedAt: "x" }), "utf8");

    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "lock_busy" });
    assert.deepEqual(calls.fireRunCalls, []);
  });

  it("cycle 已满（planIds ≥ maxPlansPerCycle）→ blocked cycle_full", async () => {
    const { scheduler, calls } = setup({
      state: { ...defaultState(), activeWorkCycleId: "cyc-1" },
      cycle: makeCycle({ planIds: ["p1", "p2", "p3"] }), // maxPlansPerCycle 默认 3
    });

    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "cycle_full" });
    assert.deepEqual(calls.fireRunCalls, []);
  });

  it("cycle 未满（planIds 少于上限）→ 正常触发", async () => {
    const { scheduler, calls } = setup({
      state: { ...defaultState(), activeWorkCycleId: "cyc-1" },
      cycle: makeCycle({ planIds: ["p1", "p2"] }),
    });

    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "fired" });
    assert.equal(calls.fireRunCalls.length, 1);
  });

  it("activeWorkCycleId 指向的 cycle 不存在 → 不按 cycle_full 拦截", async () => {
    const { scheduler } = setup({
      state: { ...defaultState(), activeWorkCycleId: "cyc-ghost" },
      cycle: undefined,
    });

    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "fired" });
  });

  it("fire.run 抛普通错误 → 重抛 AlwaysOnError(internal) 且锁已释放", async () => {
    const { scheduler, paths } = setup({
      fireRun: async () => {
        throw new Error("boom");
      },
    });

    await assert.rejects(
      () => scheduler.runTickOnce(),
      (error: unknown) => {
        assert.ok(error instanceof AlwaysOnError);
        assert.equal(error.code, "internal");
        assert.match(error.message, /boom/);
        return true;
      },
    );
    assert.ok(!existsSync(paths.discoveryLockFile), "异常路径 finally 必须释放锁");
  });

  it("fire.run 抛 AlwaysOnError → 原 code 透传重抛", async () => {
    const { scheduler } = setup({
      fireRun: async () => {
        throw new AlwaysOnError("lock_busy", "someone else holds it");
      },
    });

    await assert.rejects(
      () => scheduler.runTickOnce(),
      (error: unknown) => {
        assert.ok(error instanceof AlwaysOnError);
        assert.equal(error.code, "lock_busy");
        return true;
      },
    );
  });

  it("stop() 之后 runTickOnce → blocked disabled", async () => {
    const { scheduler, calls } = setup();
    await scheduler.stop();
    const result = await scheduler.runTickOnce();

    assert.deepEqual(result, { outcome: "blocked", reason: "disabled" });
    assert.deepEqual(calls.fireRunCalls, []);
  });

  it("no_plan + dormancy 开启 → 创建信号 watcher，stop() 后正常清理", async () => {
    const { scheduler, paths, calls } = setup({
      config: {
        ...makeConfig("/tmp/project"),
        dormancy: { ...defaultAlwaysOnConfig().dormancy, enabled: true, debounceMs: 100 },
      },
    });

    try {
      const result = await scheduler.runTickOnce();
      assert.deepEqual(result, { outcome: "fired" });
    } finally {
      await scheduler.stop();
    }
    assert.ok(calls.infos.includes("always-on fire complete"));
    assert.ok(!existsSync(paths.discoveryLockFile));
  });
});
