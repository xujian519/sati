import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDiscoveryPlanService, type DiscoveryPlanIo } from "../../../src/always-on/web/service-factory.js";

const PROJECT_ROOT = "/fake/project-root";
const PROJECT_ID = "proj-id";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-dpsf-"));
}

function projectDirOf(dir: string): string {
  return join(dir, "always-on", "projects", PROJECT_ID);
}

function writePlanIndex(dir: string, plans: unknown[]): void {
  const projectDir = projectDirOf(dir);
  mkdirSync(join(projectDir, "plans"), { recursive: true });
  writeFileSync(join(projectDir, "plans", "index.json"), JSON.stringify({ schemaVersion: 1, plans }, null, 2), "utf8");
}

function writeCycles(dir: string, cycles: unknown[]): void {
  const projectDir = projectDirOf(dir);
  mkdirSync(join(projectDir, "cycles"), { recursive: true });
  writeFileSync(
    join(projectDir, "cycles", "index.json"),
    JSON.stringify({ schemaVersion: 1, cycles }, null, 2),
    "utf8",
  );
}

function writeState(dir: string, state: Record<string, unknown>): void {
  const projectDir = projectDirOf(dir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

type IoCalls = {
  extract: string[];
  sessions: string[];
  events: Array<Record<string, unknown>>;
};

function makeIo(overrides: Partial<DiscoveryPlanIo> = {}): { io: DiscoveryPlanIo; calls: IoCalls } {
  const calls: IoCalls = { extract: [], sessions: [], events: [] };
  const io: DiscoveryPlanIo = {
    extractProjectDirectory: async projectName => {
      calls.extract.push(projectName);
      return PROJECT_ROOT;
    },
    getSessions: async projectName => {
      calls.sessions.push(projectName);
      return { sessions: [] };
    },
    isSessionActive: () => false,
    appendRunEvent: async (_projectRoot, event) => {
      calls.events.push(event as Record<string, unknown>);
    },
    appendRunLog: async () => {},
    appendRunLogEvent: async () => {},
    formatLogLine: () => "",
    ...overrides,
  };
  return { io, calls };
}

describe("createDiscoveryPlanService", () => {
  it("空 store 时 getPlansOverview 返回空列表且转发 extractProjectDirectory", async () => {
    const dir = makeTempDir();
    try {
      const { io, calls } = makeIo();
      const service = createDiscoveryPlanService({
        pilotHome: dir,
        resolveProjectId: () => PROJECT_ID,
        io,
      });
      const result = await service.getPlansOverview("demo");
      assert.deepEqual(result, { plans: [] });
      assert.deepEqual(calls.extract, ["demo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("io 会话读取被转发：有计划时 getSessions 被调用", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "ready", executionSessionId: "s1" }]);
      const projectDir = projectDirOf(dir);
      mkdirSync(join(projectDir, "plans"), { recursive: true });
      writeFileSync(join(projectDir, "plans", "p1.md"), "body", "utf8");

      const { io, calls } = makeIo();
      const service = createDiscoveryPlanService({
        pilotHome: dir,
        resolveProjectId: () => PROJECT_ID,
        io,
      });
      const result = await service.getPlansOverview("demo");
      assert.equal(result.plans.length, 1);
      assert.deepEqual(calls.sessions, ["demo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不传 resolveProjectId 时使用核心默认装配（真实 pilotHome）", async () => {
    const dir = makeTempDir();
    try {
      const { io } = makeIo();
      // extractProjectDirectory 返回真实临时目录，走核心 resolveProjectStorageId 编码
      const service = createDiscoveryPlanService({
        pilotHome: dir,
        io: {
          ...io,
          extractProjectDirectory: async () => dir,
        },
      });
      const result = await service.getPlansOverview("demo");
      assert.deepEqual(result, { plans: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state 依赖注入生效：archiveCycle 清除 activeWorkCycleId 并归档", async () => {
    const dir = makeTempDir();
    try {
      writeState(dir, { schemaVersion: 1, activeWorkCycleId: "cyc-1" });
      writeCycles(dir, [
        {
          id: "cyc-1",
          status: "active",
          workspace: { strategy: "snapshot-copy", cwd: "/nonexistent-xyz" },
          planIds: ["p1"],
        },
      ]);
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "completed" }]);

      const { io } = makeIo();
      const service = createDiscoveryPlanService({
        pilotHome: dir,
        resolveProjectId: () => PROJECT_ID,
        io,
      });
      await service.archiveCycle("demo", "cyc-1");

      const statePath = join(projectDirOf(dir), "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      assert.equal(state.activeWorkCycleId, undefined);

      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "archived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("events 依赖注入生效：queueCycleApply 写入 cycle-apply 事件", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        {
          id: "cyc-1",
          status: "active",
          workspace: { strategy: "snapshot-copy", cwd: "/nonexistent-xyz" },
          planIds: ["p1"],
        },
      ]);
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "completed" }]);

      const { io, calls } = makeIo();
      const service = createDiscoveryPlanService({
        pilotHome: dir,
        resolveProjectId: () => PROJECT_ID,
        io,
      });
      await service.queueCycleApply("demo", "cyc-1");

      const applyEvent = calls.events.find(e => e.kind === "cycle-apply")!;
      assert.equal(applyEvent.status, "queued");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
