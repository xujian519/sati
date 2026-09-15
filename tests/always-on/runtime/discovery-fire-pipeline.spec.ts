import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../../../src/always-on/config/parseAlwaysOnConfig.js";
import type {
  AlwaysOnDiscoveryState,
  DiscoveryPlanRecord,
  DiscoveryRunHistoryEvent,
  WorkCycleRecord,
} from "../../../src/always-on/protocol/types.js";
import { AlwaysOnRunContextRegistry } from "../../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "../../../src/always-on/runtime/DiscoveryFire.js";
import { SessionConfigOverrides } from "../../../src/always-on/runtime/SessionConfigOverrides.js";
import { resolveAlwaysOnPaths, type AlwaysOnPaths } from "../../../src/always-on/storage/AlwaysOnPaths.js";
import { createAlwaysOnDiscoveryPlanTool } from "../../../src/always-on/tool/AlwaysOnDiscoveryPlanTool.js";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../../src/gateway/index.js";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const PLAN_ID = "plan-1";
const CYCLE_ID = "cyc-1";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 满足 PlanContract 的最小合法计划正文（与 PlanContract.spec.ts 同源）。 */
function planMarkdown(): string {
  return [
    "# Fix slow startup",
    "",
    "> Always-On Discovery Plan",
    `> id: ${PLAN_ID}`,
    "> sourceRunId: run-1",
    "> createdAt: 2026-08-03T00:00:00Z",
    "> projectRoot: /tmp/demo",
    "> dedupeKey: dedupe-1",
    "",
    "## Summary",
    "Short summary here.",
    "",
    "## Rationale",
    "Because the agent startup path does redundant work.",
    "",
    "## Context Signals",
    "- user reported slow startup",
    "",
    "## Proposed Change",
    "Cache resolved tools between turns.",
    "",
    "## Execution Steps",
    "1. Add a cache map",
    "2. Wire it in the runtime",
    "",
    "## Verification",
    "- Startup latency drops below threshold",
    "",
  ].join("\n");
}

type Recorder = {
  events: Array<Record<string, unknown>>;
  updateStatus: Array<{ planId: string; patch: Record<string, unknown> }>;
  markFireCompleted: Array<{ outcome: string; runId: string; planId?: string; now: Date }>;
  history: DiscoveryRunHistoryEvent[];
  addPlan: Array<[string, string]>;
  closeSession: string[];
  turns: Array<{ channelKey: GatewayChannelKey; sessionKey: string; message: string }>;
  writes: string[];
  warns: Array<{ message: string; data?: Record<string, unknown> }>;
  /** 跨调用方的有序副作用轨迹，用于钉住「收尾落盘顺序」契约。 */
  trace: string[];
};

type Harness = {
  fire: DiscoveryFire;
  paths: AlwaysOnPaths;
  projectKey: string;
  recorder: Recorder;
  /** 让 gateway.closeSession 拒绝，用于验证清理失败不上抛。 */
  setCloseSessionFails: (v: boolean) => void;
  /** 抹掉计划正文，制造 plan_body_missing。 */
  clearPlanMarkdown: () => void;
  /** 把计划复位为 ready，使两条入口拿到的 planRecord 输入一致。 */
  resetPlanToReady: () => void;
  snapshot: () => Recorder;
  reset: () => void;
};

function setup(
  overrides: {
    /** 报告轮是否产出助手文本（false = 报告缺失，走退化路径）。 */
    reportText?: string | null;
    /** execution 轮是否产出 error 事件。 */
    executionError?: boolean;
    /** discovery 轮是否调用计划工具（false = 无计划产出）。 */
    producePlan?: boolean;
    /** discovery 轮是否产出 error 事件。 */
    discoveryError?: boolean;
    dormancyEnabled?: boolean;
  } = {},
): Harness {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-aon-fire-"));
  tempDirs.push(pilotHome);
  const projectKey = mkdtempSync(join(tmpdir(), "sati-aon-proj-"));
  tempDirs.push(projectKey);
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey });

  const workspace = join(paths.snapshotsDir, "ws-1");
  mkdirSync(workspace, { recursive: true });

  const recorder: Recorder = {
    events: [],
    updateStatus: [],
    markFireCompleted: [],
    history: [],
    addPlan: [],
    closeSession: [],
    turns: [],
    writes: [],
    warns: [],
    trace: [],
  };

  let closeSessionFails = false;
  let uuidSeq = 0;

  const state: AlwaysOnDiscoveryState = {
    schemaVersion: 1,
    todayKey: "2026-09-15",
    todayRunCount: 1,
    consecutiveFailures: 0,
    activeWorkCycleId: CYCLE_ID,
  };

  const cycle: WorkCycleRecord = {
    id: CYCLE_ID,
    projectKey,
    status: "active",
    workspace: { strategy: "snapshot-copy", cwd: workspace, metadata: {} },
    planIds: [],
    createdAt: NOW.toISOString(),
    createdByRunId: "run-0",
  };

  const planRecords = new Map<string, DiscoveryPlanRecord>();
  const markdowns = new Map<string, string>();

  const runContexts = new AlwaysOnRunContextRegistry();
  const sessionOverrides = new SessionConfigOverrides();

  const planTool = createAlwaysOnDiscoveryPlanTool({
    runContexts,
    now: () => NOW,
    uuid: () => `u${++uuidSeq}`,
  });

  const config: AlwaysOnConfig = {
    ...defaultAlwaysOnConfig(),
    enabled: true,
    dormancy: { enabled: overrides.dormancyEnabled ?? false, debounceMs: 0, ignoreGlobs: [] },
  };

  const deps = {
    config,
    paths,
    projectKey,
    runContexts,
    sessionOverrides,
    uuid: () => `u${++uuidSeq}`,
    now: () => NOW,
    logger: {
      info: () => undefined,
      warn: (message: string, data?: Record<string, unknown>) => {
        recorder.warns.push({ message, data });
      },
    },
    gateway: {
      submitTurn: async function* (input: {
        channelKey: GatewayChannelKey;
        sessionKey: string;
        message: string;
      }): AsyncGenerator<GatewayEvent> {
        recorder.turns.push({ channelKey: input.channelKey, sessionKey: input.sessionKey, message: input.message });
        recorder.trace.push(`turn:${input.channelKey}`);

        if (input.channelKey === "always-on/discovery") {
          if (overrides.producePlan !== false) {
            await planTool.execute(
              {
                title: "Fix slow startup",
                summary: "Short summary here.",
                rationale: "Because the agent startup path does redundant work.",
                dedupeKey: "dedupe-1",
                content: planMarkdown(),
              },
              { sessionId: input.sessionKey } as never,
            );
          }
          if (overrides.discoveryError) {
            yield { type: "error", code: "discovery_boom", message: "discovery exploded" } as GatewayEvent;
          }
        }

        if (overrides.executionError && input.channelKey === "always-on/execute") {
          yield { type: "error", code: "execution_boom", message: "execution exploded" } as GatewayEvent;
        }

        if (input.channelKey === "always-on/report" && overrides.reportText !== null) {
          yield {
            type: "assistant_text_delta",
            text: overrides.reportText ?? "# Always-On Work Report\n\n## Summary\nDid the thing.\n",
          } as GatewayEvent;
        }
      },
      closeSession: async (input: { sessionKey: string }) => {
        recorder.closeSession.push(input.sessionKey);
        recorder.trace.push(`closeSession:${input.sessionKey}`);
        if (closeSessionFails) throw new Error("close failed");
      },
    } as unknown as Gateway,
    workspaceRegistry: {
      prepare: async () => {
        throw new Error("workspace prepare should not be reached (cycle is reusable)");
      },
    },
    stateStore: {
      read: async () => state,
      markFireCompleted: async (input: { outcome: string; runId: string; planId?: string; now: Date }) => {
        recorder.markFireCompleted.push(input);
        recorder.trace.push(`markFireCompleted:${input.outcome}`);
        return state;
      },
      setActiveWorkCycleId: async () => state,
      setDormant: async () => state,
    },
    planStore: {
      getRecord: async (planId: string) => planRecords.get(planId),
      readPlanMarkdown: async (planId: string) => markdowns.get(planId),
      readIndex: async () => ({ schemaVersion: 1 as const, plans: [...planRecords.values()] }),
      updateStatus: async (planId: string, patch: Record<string, unknown>) => {
        recorder.updateStatus.push({ planId, patch });
        recorder.trace.push(`updateStatus:${String(patch.status)}`);
        const existing = planRecords.get(planId);
        if (existing) planRecords.set(planId, { ...existing, ...patch } as DiscoveryPlanRecord);
        return planRecords.get(planId);
      },
      writePlanMarkdown: async (planId: string, markdown: string) => {
        markdowns.set(planId, markdown);
        return join(paths.plansDir, `${planId}.md`);
      },
      upsert: async (record: DiscoveryPlanRecord) => {
        planRecords.set(record.id, record);
        return record;
      },
    },
    cycleStore: {
      getRecord: async (cycleId: string) => (cycleId === CYCLE_ID ? cycle : undefined),
      create: async () => cycle,
      addPlan: async (cycleId: string, planId: string) => {
        recorder.addPlan.push([cycleId, planId]);
        recorder.trace.push(`addPlan:${planId}`);
        return cycle;
      },
    },
    reportStore: {
      appendHistory: async (record: DiscoveryRunHistoryEvent) => {
        recorder.history.push(record);
        recorder.trace.push(`history:${record.outcome}`);
      },
      writeReport: async (runId: string) => {
        recorder.writes.push(runId);
        recorder.trace.push(`writeReport:${runId}`);
        return join(paths.projectDir, `${runId}.report.md`);
      },
      appendRunEvent: async () => undefined,
      closeRun: async () => undefined,
    },
    eventStore: {
      appendEvent: async (event: Record<string, unknown>) => {
        recorder.events.push(event);
      },
    },
  } as unknown as DiscoveryFireDependencies;

  return {
    fire: new DiscoveryFire(deps),
    paths,
    projectKey,
    recorder,
    setCloseSessionFails: v => {
      closeSessionFails = v;
    },
    clearPlanMarkdown: () => {
      markdowns.delete(PLAN_ID);
    },
    resetPlanToReady: () => {
      const existing = planRecords.get(PLAN_ID);
      if (!existing) return;
      planRecords.set(PLAN_ID, {
        id: existing.id,
        title: existing.title,
        createdAt: existing.createdAt,
        summary: existing.summary,
        rationale: existing.rationale,
        dedupeKey: existing.dedupeKey,
        sourceRunId: existing.sourceRunId,
        planFilePath: existing.planFilePath,
        status: "ready",
      });
    },
    snapshot: () => JSON.parse(JSON.stringify(recorder)) as Recorder,
    reset: () => {
      recorder.events = [];
      recorder.updateStatus = [];
      recorder.markFireCompleted = [];
      recorder.history = [];
      recorder.addPlan = [];
      recorder.closeSession = [];
      recorder.turns = [];
      recorder.writes = [];
      recorder.warns = [];
      recorder.trace = [];
    },
  };
}

/** 抹掉 runId（两条入口的 runId 本就不同，不属于可比内容）。 */
function stripRunIds<T>(value: T, runIds: string[]): T {
  let text = JSON.stringify(value);
  for (const id of runIds) text = text.split(id).join("<runId>");
  return JSON.parse(text) as T;
}

/** 事件里只有 phase / planId / title / outcome 属可比内容；runId 与 eventId 每次不同。 */
function eventShapes(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.map(({ runId: _runId, eventId: _eventId, projectKey: _projectKey, ...rest }) => rest);
}

describe("DiscoveryFire 共用管线：可观测契约", () => {
  it("成功路径：事件序列 / 落盘调用 / 返回值", async () => {
    const h = setup();
    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.reset();

    const result = await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-ok", startedAt: NOW });

    assert.deepEqual(
      h.recorder.events.map(e => e.phase),
      [
        "workspace_started",
        "workspace_ready",
        "execution_started",
        "execution_completed",
        "report_started",
        "report_produced",
        "run_completed",
      ],
    );
    // 收尾落盘顺序契约：plan.updateStatus → state.markFireCompleted → history.append
    assert.deepEqual(
      h.recorder.updateStatus.map(c => c.patch.status),
      ["ready", "executing", "completed"],
    );
    assert.deepEqual(h.recorder.markFireCompleted, [
      { outcome: "executed", runId: "run-ok", planId: PLAN_ID, now: NOW },
    ]);
    assert.deepEqual(h.recorder.addPlan, [[CYCLE_ID, PLAN_ID]]);
    assert.equal(h.recorder.history.length, 1);
    assert.equal(h.recorder.history[0].outcome, "executed");
    assert.equal(h.recorder.history[0].planId, PLAN_ID);
    assert.equal(h.recorder.history[0].workCycleId, CYCLE_ID);
    assert.deepEqual(h.recorder.history[0].workspace, {
      strategy: "snapshot-copy",
      handle: join(h.paths.snapshotsDir, "ws-1"),
    });
    assert.equal(h.recorder.history[0].error, undefined);

    assert.equal(result.outcome, "executed");
    assert.equal(result.planId, PLAN_ID);
    assert.ok(result.reportFilePath);
    assert.equal(result.error, undefined);

    // 跨调用方的有序轨迹：钉住「阶段会话包裹 + 收尾落盘顺序」两条契约。
    const execKey = `always-on/execute:project=${h.projectKey}:run=run-ok`;
    const reportKey = `always-on/report:project=${h.projectKey}:run=run-ok`;
    assert.deepEqual(h.recorder.trace, [
      "updateStatus:ready",
      "updateStatus:executing",
      `addPlan:${PLAN_ID}`,
      "turn:always-on/execute",
      `closeSession:${execKey}`,
      "turn:always-on/report",
      `closeSession:${reportKey}`,
      "writeReport:run-ok",
      "updateStatus:completed",
      "markFireCompleted:executed",
      "history:executed",
    ]);
  });

  it("计划缺失 / 正文缺失：就地返回，不进入管线", async () => {
    const h = setup();

    const missing = await h.fire.rerunPlan({ planId: "no-such-plan", runId: "run-x", startedAt: NOW });
    assert.equal(missing.outcome, "failed");
    assert.equal(missing.error?.code, "plan_not_found");
    assert.deepEqual(h.recorder.turns, [], "未进入管线 → 不应产生任何 turn");
    assert.deepEqual(h.recorder.updateStatus, []);
    assert.deepEqual(h.recorder.events, []);

    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.reset();
    h.clearPlanMarkdown();

    const noBody = await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-y", startedAt: NOW });
    assert.equal(noBody.outcome, "failed");
    assert.equal(noBody.error?.code, "plan_body_missing");
    assert.deepEqual(h.recorder.turns, []);
  });

  it("execution 出错：run_failed + 兜底报告 + status failed + history 带 error", async () => {
    const h = setup({ executionError: true });
    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.reset();

    const result = await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-err", startedAt: NOW });

    const phases = h.recorder.events.map(e => e.phase);
    assert.deepEqual(phases, ["workspace_started", "workspace_ready", "execution_started", "run_failed"]);
    assert.ok(!phases.includes("report_started"), "execution 失败后不得进入 report 阶段");
    assert.deepEqual(
      h.recorder.updateStatus.map(c => c.patch.status),
      ["ready", "executing", "failed"],
    );
    assert.equal(h.recorder.markFireCompleted[0].outcome, "failed");
    assert.equal(h.recorder.history[0].outcome, "failed");
    assert.equal(h.recorder.history[0].error?.code, "execution_boom");
    assert.equal(result.outcome, "failed");
    assert.equal(result.error?.code, "execution_boom");
    assert.ok(result.reportFilePath, "失败也须落一份兜底报告");
    assert.deepEqual(h.recorder.writes, ["run-err"], "只写兜底报告，不写正式报告");
  });

  it("报告缺失：退化路径 completed_no_report，不发 report_produced", async () => {
    const h = setup({ reportText: null });
    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.reset();

    const result = await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-norep", startedAt: NOW });

    const phases = h.recorder.events.map(e => e.phase);
    assert.ok(!phases.includes("report_produced"));
    assert.ok(phases.includes("report_started") && phases.includes("run_completed"));
    assert.equal(h.recorder.updateStatus.at(-1)?.patch.status, "completed_no_report");
    assert.equal(result.outcome, "executed", "报告缺失不改变 outcome");
    assert.ok(result.reportFilePath);
  });

  it("run 的 no_plan 路径：不进管线，落 no_plan 状态与历史", async () => {
    const h = setup({ producePlan: false, dormancyEnabled: true, reportText: null });

    const result = await h.fire.run({ runId: "run-noplan", startedAt: NOW });

    assert.equal(result.outcome, "no_plan");
    assert.deepEqual(
      h.recorder.events.map(e => e.phase),
      ["discovery_started", "no_plan"],
    );
    assert.deepEqual(h.recorder.updateStatus, [], "未产出计划 → 不应写任何计划状态");
    assert.deepEqual(h.recorder.addPlan, []);
    assert.deepEqual(h.recorder.markFireCompleted, [{ outcome: "no_plan", runId: "run-noplan", now: NOW }]);
    assert.equal(h.recorder.history.length, 1);
    assert.equal(h.recorder.history[0].outcome, "no_plan");
    assert.equal(h.recorder.history[0].planId, undefined, "no_plan 的历史不得带 planId");
    assert.deepEqual(h.recorder.closeSession, [`always-on/discovery:project=${h.projectKey}:run=run-noplan`]);
  });

  it("run 的 discovery 失败路径：markFailedNoPlan，不带 planId", async () => {
    const h = setup({ producePlan: false, discoveryError: true });

    const result = await h.fire.run({ runId: "run-dfail", startedAt: NOW });

    assert.equal(result.outcome, "failed");
    assert.equal(result.planId, "", "无计划时 planId 为空串");
    assert.deepEqual(
      h.recorder.events.map(e => e.phase),
      ["discovery_started", "run_failed"],
    );
    assert.deepEqual(h.recorder.markFireCompleted, [{ outcome: "failed", runId: "run-dfail", now: NOW }]);
    assert.equal(h.recorder.history[0].error?.code, "discovery_boom");
    assert.equal(h.recorder.history[0].planId, undefined);
  });

  it("会话清理：每个阶段结束都关会话", async () => {
    const h = setup();
    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.reset();

    await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-clean", startedAt: NOW });

    assert.deepEqual(h.recorder.closeSession, [
      `always-on/execute:project=${h.projectKey}:run=run-clean`,
      `always-on/report:project=${h.projectKey}:run=run-clean`,
    ]);
  });

  it("关闭会话失败不上抛：run 仍然完成并落盘", async () => {
    const h = setup();
    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.setCloseSessionFails(true);
    h.reset();

    const result = await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-closefail", startedAt: NOW });

    assert.equal(result.outcome, "executed");
    assert.equal(h.recorder.history.length, 1);
    assert.equal(h.recorder.history[0].outcome, "executed");
    assert.equal(h.recorder.writes.length, 1);
  });

  it("关闭会话失败要留痕：每个阶段各记一条 warn（不再静默吞掉）", async () => {
    const h = setup();
    await h.fire.run({ runId: "run-seed", startedAt: NOW });
    h.setCloseSessionFails(true);
    h.reset();

    await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-warn", startedAt: NOW });

    assert.deepEqual(h.recorder.warns, [
      {
        message: "always-on session close failed",
        data: { sessionKey: `always-on/execute:project=${h.projectKey}:run=run-warn`, error: "close failed" },
      },
      {
        message: "always-on session close failed",
        data: { sessionKey: `always-on/report:project=${h.projectKey}:run=run-warn`, error: "close failed" },
      },
    ]);
  });

  it("run 与 rerunPlan 对同一计划等价：提示词 / 事件 / 落盘调用 / 返回值", async () => {
    const h = setup();

    // A：首次触发（Phase 1 discovery 产出计划），随后进入共用管线
    const aResult = await h.fire.run({ runId: "run-A", startedAt: NOW });
    const a = h.snapshot();
    assert.equal(aResult.outcome, "executed");

    // B：重跑同一计划。把计划复位为 ready，使两条入口拿到的 planRecord 输入一致。
    h.resetPlanToReady();
    h.reset();
    const bResult = await h.fire.rerunPlan({ planId: PLAN_ID, runId: "run-B", startedAt: NOW });
    const b = h.snapshot();
    assert.equal(bResult.outcome, "executed");

    const ids = ["run-A", "run-B"];

    // 管线内的事件序列：A 多出 discovery 段的两条，其余必须逐项相同。
    const aPipeline = a.events.filter(e => e.phase !== "discovery_started" && e.phase !== "plan_produced");
    assert.deepEqual(eventShapes(aPipeline), eventShapes(b.events), "管线事件序列必须一致");

    // 落盘调用与返回值（runId 归一化后）
    // B（重跑入口）在进入管线前多写一次 status: "ready"——这是入口各自的前置，
    // 不属于管线语义，故单列断言，管线内的落盘调用逐项相同。
    assert.deepEqual(b.updateStatus[0], { planId: PLAN_ID, patch: { status: "ready" } });
    assert.deepEqual(stripRunIds(a.updateStatus, ids), stripRunIds(b.updateStatus.slice(1), ids));
    assert.deepEqual(stripRunIds(a.markFireCompleted, ids), stripRunIds(b.markFireCompleted, ids));
    assert.deepEqual(stripRunIds(a.history, ids), stripRunIds(b.history, ids));
    assert.deepEqual(a.addPlan, b.addPlan);
    assert.deepEqual(stripRunIds(aResult, ids), stripRunIds(bResult, ids));

    // 提示词：A 的 discovery 轮在管线外，其余逐字相同（sessionKey 内嵌 runId，归一化）。
    assert.deepEqual(
      stripRunIds(
        a.turns.filter(t => t.channelKey !== "always-on/discovery"),
        ids,
      ),
      stripRunIds(b.turns, ids),
      "进入管线的提示词必须逐字相同",
    );

    // 两边都只写一份正式报告
    assert.deepEqual(stripRunIds(a.writes, ids), stripRunIds(b.writes, ids));
  });
});
