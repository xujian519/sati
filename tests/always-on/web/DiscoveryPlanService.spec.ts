import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  DiscoveryPlanService,
  normalizeDiscoveryPlanRecord,
  type DiscoveryPlanServiceDeps,
} from "../../../src/always-on/web/DiscoveryPlanService.js";

const PROJECT_ROOT = "/fake/project-root";
const PROJECT_ID = "proj-id";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-dps-"));
}

function projectDirOf(dir: string): string {
  return join(dir, "always-on", "projects", PROJECT_ID);
}

function writePlanIndex(dir: string, plans: unknown[]): string {
  const projectDir = projectDirOf(dir);
  mkdirSync(join(projectDir, "plans"), { recursive: true });
  writeFileSync(join(projectDir, "plans", "index.json"), JSON.stringify({ schemaVersion: 1, plans }, null, 2), "utf8");
  return projectDir;
}

function writeFile(projectDir: string, relativePath: string, content: string): void {
  const target = join(projectDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
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

type Calls = {
  events: Array<Record<string, unknown>>;
  disposed: string[];
  stateCleared: string[];
};

function makeDeps(
  dir: string,
  overrides: {
    sessions?: Array<Record<string, unknown>>;
    isSessionActive?: (sessionId: string) => boolean;
    workspace?: Partial<DiscoveryPlanServiceDeps["workspace"]>;
    state?: Partial<DiscoveryPlanServiceDeps["state"]>;
  } = {},
): { deps: DiscoveryPlanServiceDeps; calls: Calls } {
  const calls: Calls = { events: [], disposed: [], stateCleared: [] };
  const deps: DiscoveryPlanServiceDeps = {
    pilotHome: dir,
    resolveProjectId: () => PROJECT_ID,
    paths: {
      extractProjectDirectory: async () => PROJECT_ROOT,
    },
    sessions: {
      getSessions: async () => ({ sessions: overrides.sessions ?? [] }),
    },
    activity: {
      isSessionActive: overrides.isSessionActive ?? (() => false),
    },
    events: {
      appendRunEvent: async (_projectRoot, event) => {
        calls.events.push(event as Record<string, unknown>);
      },
      appendRunLog: async () => {},
      appendRunLogEvent: async () => {},
      formatLogLine: () => "",
    },
    workspace: {
      applyWorktreeChanges: async () => ({ applied: true }),
      disposeWorkspace: async () => {
        calls.disposed.push("dispose");
      },
      ...overrides.workspace,
    },
    state: {
      clearActiveWorkCycleId: async () => {
        calls.stateCleared.push("clear");
      },
      ...overrides.state,
    },
  };
  return { deps, calls };
}

function makeService(
  dir: string,
  overrides: Parameters<typeof makeDeps>[1] = {},
): {
  service: DiscoveryPlanService;
  calls: Calls;
} {
  const { deps, calls } = makeDeps(dir, overrides);
  return { service: new DiscoveryPlanService(deps), calls };
}

describe("normalizeDiscoveryPlanRecord", () => {
  it("空输入返回安全默认值", () => {
    const record = normalizeDiscoveryPlanRecord(null);
    assert.equal(record.title, "Untitled discovery plan");
    assert.equal(record.status, "ready");
    assert.equal(record.structureVersion, 1);
    assert.match(record.id, /^plan-[a-f0-9]{8}$/);
    assert.deepEqual(record.contextRefs.workingDirectory, []);
    assert.deepEqual(record.contextRefs.memory, []);
    assert.equal(record.workspace, undefined);
  });

  it("gateway 状态映射为 Web 状态", () => {
    const cases: Array<[string, string]> = [
      ["executing", "running"],
      ["superseded", "archived"],
      ["applying", "completed"],
      ["applied", "archived"],
      ["apply_failed", "completed"],
      ["ready", "ready"],
      ["completed", "completed"],
    ];
    for (const [raw, expected] of cases) {
      const record = normalizeDiscoveryPlanRecord({ id: "p1", status: raw });
      assert.equal(record.status, expected, `status ${raw} → ${expected}`);
    }
  });

  it("contextRefs 数组元素归一化（去空白、过滤空串）", () => {
    const record = normalizeDiscoveryPlanRecord({
      id: "p1",
      contextRefs: { workingDirectory: [" /a ", "", "b"], memory: "not-array", existingPlans: null },
    });
    assert.deepEqual(record.contextRefs.workingDirectory, ["/a", "b"]);
    assert.deepEqual(record.contextRefs.memory, []);
    assert.deepEqual(record.contextRefs.existingPlans, []);
  });

  it("workspace 缺 strategy/cwd 时丢弃", () => {
    assert.equal(normalizeDiscoveryPlanRecord({ id: "p1", workspace: { strategy: "" } }).workspace, undefined);
    assert.equal(normalizeDiscoveryPlanRecord({ id: "p1", workspace: { cwd: "/x" } }).workspace, undefined);
    assert.deepEqual(
      normalizeDiscoveryPlanRecord({ id: "p1", workspace: { strategy: "worktree", cwd: "/x" } }).workspace,
      {
        strategy: "worktree",
        cwd: "/x",
      },
    );
  });
});

describe("DiscoveryPlanService.getPlansOverview", () => {
  it("无 index.json（空 store）返回空计划列表", async () => {
    const dir = makeTempDir();
    try {
      const { service } = makeService(dir);
      const result = await service.getPlansOverview("demo");
      assert.deepEqual(result, { plans: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("计划按状态排序（running 优先）且读取 markdown 正文", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [
        { id: "p1", title: "Plan A", status: "ready", createdAt: "2026-08-01T00:00:00Z" },
        { id: "p2", title: "Plan B", status: "executing", createdAt: "2026-08-02T00:00:00Z" },
      ]);
      writeFile(projectDirOf(dir), "plans/p1.md", "body of plan a");
      writeFile(projectDirOf(dir), "plans/p2.md", "body of plan b");

      const { service } = makeService(dir);
      const result = await service.getPlansOverview("demo");
      assert.equal(result.plans.length, 2);
      // running(0) 排在 ready(3) 之前
      assert.equal(result.plans[0]!.id, "p2");
      assert.equal(result.plans[0]!.status, "running");
      assert.equal(result.plans[0]!.content, "body of plan b");
      assert.equal(result.plans[1]!.id, "p1");
      assert.equal(result.plans[1]!.status, "ready");
      assert.equal(result.plans[1]!.content, "body of plan a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executionSessionId 命中 session 时按 session 推导状态与摘要", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "executing", executionSessionId: "s1" }]);
      writeFile(projectDirOf(dir), "plans/p1.md", "body");

      const { service } = makeService(dir, {
        sessions: [{ id: "s1", lastAssistantMessage: "session summary text", createdAt: "2026-08-02T10:00:00Z" }],
      });
      const result = await service.getPlansOverview("demo");
      const plan = result.plans[0]!;
      // 会话存在且非活跃 → executionStatus=completed → 状态 completed
      assert.equal(plan.status, "completed");
      assert.equal(plan.latestSummary, "session summary text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("执行会话活跃时 executionStatus=running", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "executing", executionSessionId: "s1" }]);
      writeFile(projectDirOf(dir), "plans/p1.md", "body");

      const { service } = makeService(dir, {
        sessions: [{ id: "s1" }],
        isSessionActive: id => id === "s1",
      });
      const result = await service.getPlansOverview("demo");
      assert.equal(result.plans[0]!.executionStatus, "running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("计划无 workspace 时从 workCycleId 回填 cycle workspace", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "ready", workCycleId: "cyc-1" }]);
      writeCycles(dir, [
        {
          id: "cyc-1",
          projectKey: "proj",
          status: "active",
          workspace: { strategy: "worktree", cwd: "/tmp/wt" },
          planIds: ["p1"],
        },
      ]);
      writeFile(projectDirOf(dir), "plans/p1.md", "body");

      const { service } = makeService(dir);
      const result = await service.getPlansOverview("demo");
      assert.deepEqual(result.plans[0]!.workspace, { strategy: "worktree", cwd: "/tmp/wt" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DiscoveryPlanService.readReport", () => {
  it("计划不存在抛 NOT_FOUND", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, []);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.readReport("demo", "missing"),
        (error: NodeJS.ErrnoException) => error.code === "NOT_FOUND",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("按 reportFilePath 读取报告正文", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", reportFilePath: "reports/run-1.md" }]);
      writeFile(projectDirOf(dir), "reports/run-1.md", "# Report body");

      const { service } = makeService(dir);
      const result = await service.readReport("demo", "p1");
      assert.equal(result.content, "# Report body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 reportFilePath 时按 sourceRunId 推断 reports/<runId>.md", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", sourceRunId: "run-42" }]);
      writeFile(projectDirOf(dir), "reports/run-42.md", "inferred report");

      const { service } = makeService(dir);
      const result = await service.readReport("demo", "p1");
      assert.equal(result.content, "inferred report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无报告路径且无 runId 时返回空内容", async () => {
    const dir = makeTempDir();
    try {
      writePlanIndex(dir, [{ id: "p1", title: "Plan A" }]);
      const { service } = makeService(dir);
      const result = await service.readReport("demo", "p1");
      assert.equal(result.content, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DiscoveryPlanService.archiveCycle", () => {
  it("cycle 不存在抛 NOT_FOUND", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, []);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.archiveCycle("demo", "cyc-1"),
        (error: NodeJS.ErrnoException) => error.code === "NOT_FOUND",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("正在 applying 的 cycle 禁止归档", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "applying", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: [] },
      ]);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.archiveCycle("demo", "cyc-1"),
        (error: NodeJS.ErrnoException) => error.code === "INVALID_STATE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("归档后 cycle 置 archived、关联计划置 archived、清理 workspace 与状态", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "active", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
      ]);
      writePlanIndex(dir, [
        { id: "p1", title: "Plan A", status: "completed" },
        { id: "p2", title: "Plan B", status: "ready" },
      ]);

      const { service, calls } = makeService(dir);
      const result = await service.archiveCycle("demo", "cyc-1");
      assert.deepEqual(result, { archived: true });

      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "archived");
      assert.ok(cycles[0]!.archivedAt);

      const overview = await service.getPlansOverview("demo");
      const p1 = overview.plans.find(p => p.id === "p1")!;
      const p2 = overview.plans.find(p => p.id === "p2")!;
      assert.equal(p1.status, "archived");
      assert.equal(p2.status, "ready");

      assert.deepEqual(calls.disposed, ["dispose"]);
      assert.deepEqual(calls.stateCleared, ["clear"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DiscoveryPlanService.queueCycleApply", () => {
  it("cycle 不存在抛 NOT_FOUND", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, []);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.queueCycleApply("demo", "cyc-1"),
        (error: NodeJS.ErrnoException) => error.code === "NOT_FOUND",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 active 状态抛 INVALID_STATE", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "archived", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: [] },
      ]);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.queueCycleApply("demo", "cyc-1"),
        (error: NodeJS.ErrnoException) => error.code === "INVALID_STATE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 workspace 抛 MISSING_WORKSPACE", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [{ id: "cyc-1", status: "active", planIds: [] }]);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.queueCycleApply("demo", "cyc-1"),
        (error: NodeJS.ErrnoException) => error.code === "MISSING_WORKSPACE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无已完成计划抛 INVALID_STATE", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "active", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
      ]);
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "ready" }]);
      const { service } = makeService(dir);
      await assert.rejects(
        () => service.queueCycleApply("demo", "cyc-1"),
        (error: NodeJS.ErrnoException) => error.code === "INVALID_STATE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("正常排队：cycle 置 applying、写入 cycle-apply 事件、返回 executionToken", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "active", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
      ]);
      writePlanIndex(dir, [
        { id: "p1", title: "Plan A", status: "completed" },
        { id: "p2", title: "Plan B", status: "completed_no_report" },
      ]);

      const { service, calls } = makeService(dir);
      const result = await service.queueCycleApply("demo", "cyc-1");
      assert.equal(result.cycle.status, "applying");
      assert.equal(result.projectRoot, PROJECT_ROOT);
      assert.ok(result.executionToken);

      const applyEvent = calls.events.find(e => e.kind === "cycle-apply")!;
      assert.equal(applyEvent.status, "queued");
      const metadata = applyEvent.metadata as Record<string, unknown>;
      assert.equal(metadata.cycleId, "cyc-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DiscoveryPlanService.updateCycleExecution", () => {
  it("completed → cycle 置 applied、关联计划归档、清理 workspace 与状态", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "applying", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
      ]);
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "completed" }]);

      const { service, calls } = makeService(dir);
      await service.updateCycleExecution("demo", "cyc-1", { status: "completed", executionSessionId: "s9" });

      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "applied");
      assert.ok(cycles[0]!.appliedAt);

      const overview = await service.getPlansOverview("demo");
      assert.equal(overview.plans[0]!.status, "archived");
      assert.deepEqual(calls.disposed, ["dispose"]);
      assert.deepEqual(calls.stateCleared, ["clear"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("failed → cycle 回退为 active，不清理 workspace", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "applying", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
      ]);
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "completed" }]);

      const { service, calls } = makeService(dir);
      await service.updateCycleExecution("demo", "cyc-1", { status: "failed" });

      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "active");
      assert.deepEqual(calls.disposed, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 applying 状态不产生副作用", async () => {
    const dir = makeTempDir();
    try {
      writeCycles(dir, [
        { id: "cyc-1", status: "active", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
      ]);
      writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "completed" }]);

      const { service, calls } = makeService(dir);
      await service.updateCycleExecution("demo", "cyc-1", { status: "completed" });

      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "active");
      assert.deepEqual(calls.disposed, []);
      assert.deepEqual(calls.stateCleared, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DiscoveryPlanService.applyCycle（状态机收编）", () => {
  function setup(dir: string) {
    writeCycles(dir, [
      { id: "cyc-1", status: "active", workspace: { strategy: "worktree", cwd: "/tmp/wt" }, planIds: ["p1"] },
    ]);
    writePlanIndex(dir, [{ id: "p1", title: "Plan A", status: "completed" }]);
  }

  it("成功路径：queue → apply → finalize（cycle 置 applied、sessionKey 透传）", async () => {
    const dir = makeTempDir();
    try {
      setup(dir);
      const { service, calls } = makeService(dir);
      const result = await service.applyCycle("demo", "cyc-1", async input => {
        assert.equal(input.projectKey, PROJECT_ROOT);
        assert.equal(input.workCycleId, "cyc-1");
        return { sessionKey: "s9" };
      });

      assert.equal(result.error, undefined);
      assert.equal(result.sessionKey, "s9");
      assert.equal(result.cycle?.status, "applied");
      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "applied");
      assert.deepEqual(calls.disposed, ["dispose"], "applied 后应清理 workspace");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败路径：apply 返回 error → cycle 回退为 active", async () => {
    const dir = makeTempDir();
    try {
      setup(dir);
      const { service, calls } = makeService(dir);
      const result = await service.applyCycle("demo", "cyc-1", async () => ({
        sessionKey: "",
        error: { code: "apply_error", message: "boom" },
      }));

      assert.equal(result.error?.code, "apply_error");
      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "active", "失败后不得停留在 applying");
      assert.deepEqual(calls.disposed, [], "失败不应清理 workspace");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败路径：apply 抛异常 → 同样回滚为 active（不卡死在 applying）", async () => {
    const dir = makeTempDir();
    try {
      setup(dir);
      const { service } = makeService(dir);
      const result = await service.applyCycle("demo", "cyc-1", async () => {
        throw new Error("gateway exploded");
      });

      assert.equal(result.error?.code, "apply_error");
      assert.match(result.error?.message ?? "", /gateway exploded/);
      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "active", "apply 抛异常时 cycle 必须回滚，不得停留在 applying");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未提供 apply 回调 → not_configured 且不排队", async () => {
    const dir = makeTempDir();
    try {
      setup(dir);
      const { service, calls } = makeService(dir);
      const result = await service.applyCycle("demo", "cyc-1", undefined);

      assert.equal(result.error?.code, "not_configured");
      assert.equal(result.cycle, null);
      assert.equal(
        calls.events.some(e => e.kind === "cycle-apply"),
        false,
        "不应写入 queued 事件",
      );
      const cycles = (await service.getCyclesOverview("demo")).cycles;
      assert.equal(cycles[0]!.status, "active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
