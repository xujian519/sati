import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  AlwaysOnCurrentWorkspaceRef,
  AlwaysOnDiscoveryState,
  DiscoveryPlanIndex,
  WorkCycleIndex,
} from "../../../src/always-on/protocol/types.js";
import { resolveAlwaysOnPaths, type AlwaysOnPaths } from "../../../src/always-on/storage/AlwaysOnPaths.js";
import {
  defaultDiscoveryState,
  DiscoveryStateStore,
  getDayKey,
} from "../../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../../src/always-on/storage/WorkCycleStore.js";

const tempDirs: string[] = [];

function makeStores(): {
  stateStore: DiscoveryStateStore;
  cycleStore: WorkCycleStore;
  paths: AlwaysOnPaths;
} {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-aon-state-"));
  tempDirs.push(pilotHome);
  const projectKey = mkdtempSync(join(tmpdir(), "sati-aon-proj-"));
  tempDirs.push(projectKey);
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey });
  return {
    stateStore: new DiscoveryStateStore(paths),
    cycleStore: new WorkCycleStore(paths),
    paths,
  };
}

function makeState(overrides: Partial<AlwaysOnDiscoveryState> = {}): AlwaysOnDiscoveryState {
  // read() 经 normalizeState 重建时会保留全部可选键（值为 undefined），
  // 因此期望值也要显式携带这些键，deepStrictEqual 才相等。
  return {
    schemaVersion: 1,
    lastFireStartedAt: undefined,
    lastFireCompletedAt: undefined,
    lastFireOutcome: undefined,
    lastPlanId: undefined,
    lastRunId: undefined,
    todayKey: "2026-08-03",
    todayRunCount: 0,
    consecutiveFailures: 0,
    dormant: undefined,
    activeWorkCycleId: undefined,
    currentWorkspace: undefined,
    ...overrides,
  };
}

function writeJsonFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("getDayKey / defaultDiscoveryState", () => {
  it("getDayKey 返回 YYYY-MM-DD", () => {
    assert.equal(getDayKey(new Date("2026-08-03T10:00:00.000Z")), "2026-08-03");
  });

  it("defaultDiscoveryState 使用当前日期且计数归零", () => {
    const now = new Date("2026-08-03T23:59:59.000Z");
    assert.deepEqual(defaultDiscoveryState(now), {
      schemaVersion: 1,
      todayKey: "2026-08-03",
      todayRunCount: 0,
      consecutiveFailures: 0,
    });
  });
});

describe("DiscoveryStateStore", () => {
  it("空目录 read → 默认状态（不抛错）", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    assert.deepEqual(await stateStore.read(now), defaultDiscoveryState(now));
  });

  it("write + read 往返完整保留可选字段", async () => {
    const { stateStore } = makeStores();
    const state = makeState({
      lastFireStartedAt: "2026-08-03T09:00:00.000Z",
      lastFireCompletedAt: "2026-08-03T09:30:00.000Z",
      lastFireOutcome: "executed",
      lastPlanId: "plan-1",
      lastRunId: "run-1",
      todayRunCount: 2,
      consecutiveFailures: 1,
      activeWorkCycleId: "cyc-1",
    });
    await stateStore.write(state);
    assert.deepEqual(await stateStore.read(new Date("2026-08-03T12:00:00.000Z")), state);
  });

  it("损坏的 JSON → 回落默认状态", async () => {
    const { stateStore, paths } = makeStores();
    writeJsonFile(paths.stateFile, "{ not valid json");
    const now = new Date("2026-08-03T10:00:00.000Z");
    assert.deepEqual(await stateStore.read(now), defaultDiscoveryState(now));
  });

  it("schemaVersion 非 1 → 回落默认状态", async () => {
    const { stateStore, paths } = makeStores();
    writeJsonFile(paths.stateFile, JSON.stringify({ schemaVersion: 2, todayKey: "2026-08-03" }));
    const now = new Date("2026-08-03T10:00:00.000Z");
    assert.deepEqual(await stateStore.read(now), defaultDiscoveryState(now));
  });

  it("非法数值被归一化（负 todayRunCount → 0）", async () => {
    const { stateStore, paths } = makeStores();
    writeJsonFile(
      paths.stateFile,
      JSON.stringify({ schemaVersion: 1, todayKey: "2026-08-03", todayRunCount: -5, consecutiveFailures: -1 }),
    );
    const state = await stateStore.read(new Date("2026-08-03T10:00:00.000Z"));
    assert.equal(state.todayRunCount, 0);
    assert.equal(state.consecutiveFailures, 0);
  });

  it("markFireStarted 递增 todayRunCount 并记录 runId / 时间", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    const next = await stateStore.markFireStarted("run-1", now);

    assert.equal(next.todayRunCount, 1);
    assert.equal(next.lastFireStartedAt, now.toISOString());
    assert.equal(next.lastRunId, "run-1");
    // 落盘后可读回
    const persisted = await stateStore.read(now);
    assert.equal(persisted.todayRunCount, 1);
    assert.equal(persisted.lastRunId, "run-1");
  });

  it("跨日 budget 重置：todayKey 不同时 todayRunCount 归零", async () => {
    const { stateStore } = makeStores();
    await stateStore.write(makeState({ todayKey: "2026-08-02", todayRunCount: 5, consecutiveFailures: 2 }));

    const today = new Date("2026-08-03T01:00:00.000Z");
    const state = await stateStore.read(today);
    assert.equal(state.todayKey, "2026-08-03");
    assert.equal(state.todayRunCount, 0);
    assert.equal(state.consecutiveFailures, 2, "跨日重置只影响今日预算，不影响累计失败数");
  });

  it("同一日 read 不重置今日计数", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await stateStore.markFireStarted("run-1", now);
    const state = await stateStore.read(now);
    assert.equal(state.todayRunCount, 1);
  });

  it("markFireCompleted：failed 递增连续失败，其余归零", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await stateStore.write(makeState({ consecutiveFailures: 1 }));

    const failed = await stateStore.markFireCompleted({ outcome: "failed", runId: "run-1", planId: "p1", now });
    assert.equal(failed.consecutiveFailures, 2);
    assert.equal(failed.lastFireOutcome, "failed");
    assert.equal(failed.lastPlanId, "p1");
    assert.equal(failed.lastRunId, "run-1");
    assert.equal(failed.lastFireCompletedAt, now.toISOString());

    const ok = await stateStore.markFireCompleted({ outcome: "no_plan", runId: "run-2", now });
    assert.equal(ok.consecutiveFailures, 0);
    assert.equal(ok.lastFireOutcome, "no_plan");
  });

  it("setDormant / clearDormant：设置与清除、幂等", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");

    const dormant = await stateStore.setDormant(now);
    assert.deepEqual(dormant.dormant, { since: now.toISOString(), lastBaselineAt: now.toISOString() });

    const readBack = await stateStore.read(now);
    // normalizeState 重建 dormant 时会显式保留 lastChangeAt 键（undefined）
    assert.equal(readBack.dormant?.since, now.toISOString());
    assert.equal(readBack.dormant?.lastBaselineAt, now.toISOString());
    assert.equal(readBack.dormant?.lastChangeAt, undefined);

    const cleared = await stateStore.clearDormant(now);
    assert.equal(cleared.dormant, undefined);
    assert.equal((await stateStore.read(now)).dormant, undefined);

    // 无 dormant 时再 clear 原样返回
    const again = await stateStore.clearDormant(now);
    assert.equal(again.dormant, undefined);
  });

  it("setActiveWorkCycleId 设置 cycleId 并删除遗留 currentWorkspace", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    const legacy: AlwaysOnCurrentWorkspaceRef = {
      runId: "run-0",
      strategy: "git-worktree",
      cwd: "/tmp/legacy-ws",
      metadata: {},
    };
    await stateStore.write(makeState({ currentWorkspace: legacy }));

    const next = await stateStore.setActiveWorkCycleId("cyc-1", now);
    assert.equal(next.activeWorkCycleId, "cyc-1");
    assert.equal(next.currentWorkspace, undefined);

    const persisted = await stateStore.read(now);
    assert.equal(persisted.activeWorkCycleId, "cyc-1");
    assert.equal(persisted.currentWorkspace, undefined);
  });

  it("clearActiveWorkCycleId：删除 activeWorkCycleId；不存在时无副作用", async () => {
    const { stateStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await stateStore.setActiveWorkCycleId("cyc-1", now);

    const cleared = await stateStore.clearActiveWorkCycleId(now);
    assert.equal(cleared.activeWorkCycleId, undefined);

    const again = await stateStore.clearActiveWorkCycleId(now);
    assert.equal(again.activeWorkCycleId, undefined);
  });
});

describe("WorkCycleStore", () => {
  it("空目录 readIndex → 空索引；非法 JSON/结构 → 空索引", async () => {
    const { cycleStore } = makeStores();
    assert.deepEqual(await cycleStore.readIndex(), { schemaVersion: 1, cycles: [] });

    const { cycleStore: bad, paths } = makeStores();
    writeJsonFile(paths.cycleIndexFile, "{ broken");
    assert.deepEqual(await bad.readIndex(), { schemaVersion: 1, cycles: [] });

    writeJsonFile(paths.cycleIndexFile, JSON.stringify({ schemaVersion: 2, cycles: [] }));
    assert.deepEqual(await bad.readIndex(), { schemaVersion: 1, cycles: [] });
  });

  it("create → 记录落盘，getRecord / getActiveCycle 可读回", async () => {
    const { cycleStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    const record = await cycleStore.create(
      {
        runId: "run-1",
        projectKey: "/tmp/proj",
        strategy: "git-worktree",
        cwd: "/tmp/ws",
        metadata: { branchName: "feat/x" },
      },
      "run-1",
      "cyc-1",
      now,
    );

    assert.equal(record.id, "cyc-1");
    assert.equal(record.status, "active");
    assert.equal(record.createdByRunId, "run-1");
    assert.equal(record.createdAt, now.toISOString());
    assert.deepEqual(record.planIds, []);
    assert.deepEqual(record.workspace, {
      strategy: "git-worktree",
      cwd: "/tmp/ws",
      metadata: { branchName: "feat/x" },
    });

    assert.deepEqual(await cycleStore.getRecord("cyc-1"), record);
    assert.deepEqual(await cycleStore.getActiveCycle(), record);
  });

  it("getActiveCycle 只返回 active 的 cycle", async () => {
    const { cycleStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await cycleStore.create(
      { runId: "r1", projectKey: "p", strategy: "git-worktree", cwd: "/w1", metadata: {} },
      "r1",
      "cyc-1",
      now,
    );
    await cycleStore.create(
      { runId: "r2", projectKey: "p", strategy: "snapshot-copy", cwd: "/w2", metadata: {} },
      "r2",
      "cyc-2",
      now,
    );

    await cycleStore.updateStatus("cyc-1", "applied", now);
    const active = await cycleStore.getActiveCycle();
    assert.equal(active?.id, "cyc-2");
  });

  it("addPlan：追加并去重；不存在的 cycle 为 no-op", async () => {
    const { cycleStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await cycleStore.create(
      { runId: "r1", projectKey: "p", strategy: "git-worktree", cwd: "/w", metadata: {} },
      "r1",
      "cyc-1",
      now,
    );

    await cycleStore.addPlan("cyc-1", "p1");
    await cycleStore.addPlan("cyc-1", "p2");
    await cycleStore.addPlan("cyc-1", "p1"); // 重复

    assert.deepEqual((await cycleStore.getRecord("cyc-1"))?.planIds, ["p1", "p2"]);
    await cycleStore.addPlan("cyc-ghost", "p9"); // 不抛、无副作用
  });

  it("updateStatus：applied / archived 写入时间戳；未知 cycle → undefined", async () => {
    const { cycleStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await cycleStore.create(
      { runId: "r1", projectKey: "p", strategy: "git-worktree", cwd: "/w", metadata: {} },
      "r1",
      "cyc-1",
      now,
    );

    const applied = await cycleStore.updateStatus("cyc-1", "applied", now);
    assert.equal(applied?.status, "applied");
    assert.equal(applied?.appliedAt, now.toISOString());
    assert.equal(applied?.archivedAt, undefined);

    const archived = await cycleStore.updateStatus("cyc-1", "archived", now);
    assert.equal(archived?.archivedAt, now.toISOString());

    assert.equal(await cycleStore.updateStatus("cyc-ghost", "applied", now), undefined);
  });

  it("writeIndex 后 readIndex 往返一致", async () => {
    const { cycleStore } = makeStores();
    const index: WorkCycleIndex = {
      schemaVersion: 1,
      cycles: [
        {
          id: "cyc-1",
          projectKey: "p",
          status: "active",
          workspace: { strategy: "git-worktree", cwd: "/w", metadata: {} },
          planIds: ["p1"],
          createdAt: "2026-08-03T10:00:00.000Z",
          createdByRunId: "r1",
        },
      ],
    };
    await cycleStore.writeIndex(index);
    assert.deepEqual(await cycleStore.readIndex(), index);
  });
});

describe("WorkCycleStore.migrateFromLegacy", () => {
  it("已有 cycles → 不迁移（返回 undefined）", async () => {
    const { cycleStore } = makeStores();
    const now = new Date("2026-08-03T10:00:00.000Z");
    await cycleStore.create(
      { runId: "r1", projectKey: "p", strategy: "git-worktree", cwd: "/w", metadata: {} },
      "r1",
      "cyc-1",
      now,
    );
    assert.equal(await cycleStore.migrateFromLegacy(), undefined);
  });

  it("无 state.json → 不迁移", async () => {
    const { cycleStore } = makeStores();
    assert.equal(await cycleStore.migrateFromLegacy(), undefined);
  });

  it("state 无 currentWorkspace → 不迁移", async () => {
    const { stateStore, cycleStore } = makeStores();
    await stateStore.write(makeState());
    assert.equal(await cycleStore.migrateFromLegacy(), undefined);
  });

  it("currentWorkspace.cwd 不存在 → 不迁移", async () => {
    const { stateStore, cycleStore } = makeStores();
    await stateStore.write(
      makeState({
        currentWorkspace: { runId: "run-0", strategy: "git-worktree", cwd: "/no/such/dir", metadata: {} },
      }),
    );
    assert.equal(await cycleStore.migrateFromLegacy(), undefined);
  });

  it("完整迁移：按 cwd 关联计划、改写 state.json 与 planIndex", async () => {
    const { stateStore, cycleStore, paths } = makeStores();
    const cwd = mkdtempSync(join(tmpdir(), "sati-aon-legacy-ws-"));
    tempDirs.push(cwd);

    await stateStore.write(
      makeState({
        currentWorkspace: { runId: "run-legacy", strategy: "git-worktree", cwd, metadata: { branchName: "feat/x" } },
      }),
    );

    const planIndex: DiscoveryPlanIndex = {
      schemaVersion: 1,
      plans: [
        {
          id: "p1",
          title: "P1",
          createdAt: "2026-08-02T00:00:00.000Z",
          status: "ready",
          summary: "s",
          rationale: "r",
          dedupeKey: "d1",
          sourceRunId: "run-legacy",
          planFilePath: "/plans/p1.md",
          workspace: { strategy: "git-worktree", handle: "h1", cwd },
        },
        {
          id: "p2",
          title: "P2",
          createdAt: "2026-08-02T00:00:00.000Z",
          status: "completed",
          summary: "s",
          rationale: "r",
          dedupeKey: "d2",
          sourceRunId: "run-other",
          planFilePath: "/plans/p2.md",
          workspace: { strategy: "git-worktree", handle: "h2", cwd: "/other/ws" },
        },
        {
          id: "p3",
          title: "P3",
          createdAt: "2026-08-02T00:00:00.000Z",
          status: "ready",
          summary: "s",
          rationale: "r",
          dedupeKey: "d3",
          sourceRunId: "run-x",
          planFilePath: "/plans/p3.md",
        },
      ],
    };
    writeJsonFile(paths.planIndexFile, JSON.stringify(planIndex, null, 2));

    const record = await cycleStore.migrateFromLegacy();
    assert.ok(record, "应迁移出 cycle");
    assert.equal(record.status, "active");
    assert.equal(record.createdByRunId, "run-legacy");
    assert.equal(record.projectKey, paths.projectKey);
    assert.deepEqual(record.workspace, { strategy: "git-worktree", cwd, metadata: { branchName: "feat/x" } });
    assert.deepEqual(record.planIds, ["p1"], "只关联同 workspace.cwd 的计划");

    // state.json：currentWorkspace → activeWorkCycleId
    const stateAfter = JSON.parse(readFileSync(paths.stateFile, "utf8")) as Record<string, unknown>;
    assert.equal(stateAfter.activeWorkCycleId, record.id);
    assert.equal(stateAfter.currentWorkspace, undefined);

    // planIndex：匹配计划获得 workCycleId 并删除 workspace
    const planIndexAfter = JSON.parse(readFileSync(paths.planIndexFile, "utf8")) as DiscoveryPlanIndex;
    const p1 = planIndexAfter.plans.find(p => p.id === "p1")!;
    assert.equal(p1.workCycleId, record.id);
    assert.equal(p1.workspace, undefined);
    const p2 = planIndexAfter.plans.find(p => p.id === "p2")!;
    assert.equal(p2.workCycleId, undefined);
    assert.equal(p2.workspace?.cwd, "/other/ws");
    const p3 = planIndexAfter.plans.find(p => p.id === "p3")!;
    assert.equal(p3.workCycleId, undefined);
  });
});
