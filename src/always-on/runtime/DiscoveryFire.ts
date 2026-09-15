import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../gateway/index.js";
import { getPilotProjectChatDir } from "../../shared/paths/index.js";
import { buildChatDigest } from "../context/ChatDigestBuilder.js";
import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import { buildFallbackReport, parseReportMarkdown, type ReportMetadata } from "../contracts/ReportContract.js";
import { AlwaysOnError } from "../protocol/errors.js";
import type {
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  AlwaysOnEventPhase,
  DiscoveryFireResult,
  DiscoveryPlanRecord,
  DiscoveryRunHistoryEvent,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../protocol/types.js";
import type { AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../storage/WorkCycleStore.js";
import type { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { generateWorkspaceDiff } from "../workspace/WorkspaceApply.js";
import type { PermissionRule } from "../../permission/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type {
  AlwaysOnRunContextRegistry,
  ExecutionRunContext,
  DiscoveryRunContext,
  WorkspaceRunContext,
  ReportRunContext,
} from "./AlwaysOnRunContextRegistry.js";
import {
  buildDiscoveryPrompt,
  buildExecutionPrompt,
  buildWorkspacePrompt,
  buildReportPrompt,
  buildApplyPrompt,
} from "./discoveryPrompts.js";
import { UNATTENDED_SESSION_EXCLUDED_TOOLS, type SessionConfigOverrides } from "./SessionConfigOverrides.js";

export type DiscoveryFireDependencies = {
  config: AlwaysOnConfig;
  paths: AlwaysOnPaths;
  projectKey: string;
  gateway: Gateway;
  runContexts: AlwaysOnRunContextRegistry;
  workspaceRegistry: WorkspaceProviderRegistry;
  sessionOverrides: SessionConfigOverrides;
  stateStore: DiscoveryStateStore;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  reportStore: DiscoveryReportStore;
  eventStore: AlwaysOnEventStore;
  uuid: () => string;
  now: () => Date;
  logger?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
  };
  onTurnEvent?: (sessionKey: string, channelKey: string, event: GatewayEvent) => void;
  telemetry?: TelemetryClient;
};

export type DiscoveryFireRunInput = {
  /** Pre-allocated runId (already used by the lock + state store). */
  runId: string;
  startedAt: Date;
};

const DISCOVERY_CHANNEL: GatewayChannelKey = "always-on/discovery";
const WORKSPACE_CHANNEL: GatewayChannelKey = "always-on/workspace";
const EXECUTION_CHANNEL: GatewayChannelKey = "always-on/execute";
const REPORT_CHANNEL: GatewayChannelKey = "always-on/report";
const APPLY_CHANNEL: GatewayChannelKey = "always-on/apply";

/**
 * Deny rules injected into the execution phase session. These override
 * `bypassPermissions` because deny rules always win in `PermissionRuntime.decide()`.
 * Prevents the agent from pushing code or modifying remote configuration.
 */
export const ALWAYS_ON_EXECUTION_DENY_RULES: PermissionRule[] = [
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "git push*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "git remote*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "*git push*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "*git remote*" },
];

function toTelemetryAlwaysOnPhase(
  phase: AlwaysOnEventPhase,
): "discovery" | "workspace" | "execution" | "report" | "apply" {
  if (phase.startsWith("workspace_")) return "workspace";
  if (phase.startsWith("execution_")) return "execution";
  if (phase.startsWith("report_")) return "report";
  if (phase.startsWith("apply_")) return "apply";
  return "discovery";
}

export type EnsureActiveWorkCycleInput = {
  state: AlwaysOnDiscoveryState;
  projectKey: string;
  runId: string;
  planTitle: string;
  cycleId: string;
  workspaceRegistry: WorkspaceProviderRegistry;
  stateStore: DiscoveryStateStore;
  cycleStore: WorkCycleStore;
  now: () => Date;
  fileExists?: (path: string) => boolean;
};

export type EnsureActiveWorkCycleResult = {
  handle: WorkspaceHandle;
  cycle: WorkCycleRecord;
  reused: boolean;
};

/**
 * Look up the project's active work cycle. If a cycle exists with its
 * workspace still on disk, reuse it. Otherwise prepare a new workspace and
 * create a new cycle. Always-On runs at most one active cycle (and one
 * workspace) per project; this function is the single source of truth.
 */
export async function ensureActiveWorkCycle(input: EnsureActiveWorkCycleInput): Promise<EnsureActiveWorkCycleResult> {
  const fileExists = input.fileExists ?? existsSync;

  if (input.state.activeWorkCycleId) {
    const existing = await input.cycleStore.getRecord(input.state.activeWorkCycleId);
    if (existing && existing.status === "active" && fileExists(existing.workspace.cwd)) {
      return {
        handle: {
          runId: existing.createdByRunId,
          projectKey: input.projectKey,
          strategy: existing.workspace.strategy,
          cwd: existing.workspace.cwd,
          metadata: { ...existing.workspace.metadata },
        },
        cycle: existing,
        reused: true,
      };
    }
  }

  // Legacy migration: state still has currentWorkspace but no activeWorkCycleId
  if (input.state.currentWorkspace && fileExists(input.state.currentWorkspace.cwd)) {
    const ref = input.state.currentWorkspace;
    const handle: WorkspaceHandle = {
      runId: ref.runId,
      projectKey: input.projectKey,
      strategy: ref.strategy,
      cwd: ref.cwd,
      metadata: { ...ref.metadata },
    };
    const cycle = await input.cycleStore.create(handle, ref.runId, input.cycleId, input.now());
    await input.stateStore.setActiveWorkCycleId(cycle.id, input.now());
    return { handle, cycle, reused: true };
  }

  const prepared = await input.workspaceRegistry.prepare({
    projectRoot: input.projectKey,
    runId: input.runId,
    planTitle: input.planTitle,
  });
  const cycle = await input.cycleStore.create(prepared.handle, input.runId, input.cycleId, input.now());
  await input.stateStore.setActiveWorkCycleId(cycle.id, input.now());
  return { handle: prepared.handle, cycle, reused: false };
}

export class DiscoveryFire {
  constructor(private readonly deps: DiscoveryFireDependencies) {}

  private emitEvent(
    runId: string,
    phase: AlwaysOnEventPhase,
    extra?: {
      title?: string;
      planId?: string;
      outcome?: AlwaysOnDiscoveryOutcome;
      error?: { code: string; message: string };
      telemetryPhase?: "discovery" | "workspace" | "execution" | "report" | "apply";
    },
  ): void {
    const telemetryPhase = extra?.telemetryPhase ?? toTelemetryAlwaysOnPhase(phase);
    const { telemetryPhase: _telemetryPhase, ...eventExtra } = extra ?? {};
    this.deps.telemetry?.trackFeatureLoopStage({
      module: "always_on",
      ownerModule: "always_on",
      executionKind: "always_on",
      phase: telemetryPhase,
      loopStage: "module_event",
      outcome: phase === "run_failed" ? "failed" : "success",
      metadata: {
        event: phase,
        runId,
        planId: extra?.planId,
        outcome: extra?.outcome,
      },
    });
    if (extra?.error) {
      this.deps.telemetry?.trackError(extra.error.message, {
        module: "always_on",
        ownerModule: "always_on",
        executionKind: "always_on",
        phase: telemetryPhase,
        loopStage: "loop_end",
        errorCategory: "loop_error",
        code: extra.error.code,
        metadata: {
          runId,
          phase,
          planId: extra.planId,
        },
      });
    }
    this.deps.eventStore
      .appendEvent({
        schemaVersion: 1,
        eventId: this.deps.uuid(),
        runId,
        projectKey: this.deps.projectKey,
        phase,
        timestamp: this.deps.now().toISOString(),
        ...eventExtra,
      })
      .catch(() => undefined);
  }

  static deriveDiscoverySessionKey(projectKey: string, runId: string): string {
    return `always-on/discovery:project=${projectKey}:run=${runId}`;
  }

  static deriveWorkspaceSessionKey(projectKey: string, runId: string): string {
    return `always-on/workspace:project=${projectKey}:run=${runId}`;
  }

  static deriveExecutionSessionKey(projectKey: string, runId: string): string {
    return `always-on/execute:project=${projectKey}:run=${runId}`;
  }

  static deriveReportSessionKey(projectKey: string, runId: string): string {
    return `always-on/report:project=${projectKey}:run=${runId}`;
  }

  static deriveApplySessionKey(projectKey: string, runId: string): string {
    return `always-on/apply:project=${projectKey}:run=${runId}`;
  }

  async runApplyPhase(input: {
    runId: string;
    cycle: WorkCycleRecord;
    plans: Array<{ id: string; title: string }>;
    projectName: string;
    projectRoot: string;
  }): Promise<{ events: GatewayEvent[]; error?: { code: string; message: string }; sessionKey: string }> {
    const { cycle, projectRoot } = input;

    const diff = await generateWorkspaceDiff(cycle.workspace.strategy, cycle.workspace.cwd, projectRoot);

    const sessionKey = DiscoveryFire.deriveApplySessionKey(this.deps.projectKey, input.runId);
    this.emitEvent(input.runId, "apply_started", { outcome: "executed" });
    this.deps.sessionOverrides.set(sessionKey, {
      cwd: projectRoot,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    try {
      const events = await this.drainTurn({
        sessionKey,
        channelKey: APPLY_CHANNEL,
        runId: `${input.runId}.apply`,
        message: buildApplyPrompt({
          plan: {
            id: cycle.id,
            title: input.plans.map(p => p.title).join("; "),
            workspace: { cwd: cycle.workspace.cwd, strategy: cycle.workspace.strategy },
          },
          projectName: input.projectName,
          projectRoot,
          diff,
          branchName: cycle.workspace.metadata?.branchName as string | undefined,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      const error = pickFirstError(events);
      if (error) {
        this.emitEvent(input.runId, "run_failed", {
          outcome: "failed",
          telemetryPhase: "apply",
          error: { code: error.code ?? "apply_failed", message: error.message },
        });
      } else {
        this.emitEvent(input.runId, "apply_completed", { outcome: "executed" });
      }
      return {
        events,
        sessionKey,
        error: error ? { code: error.code ?? "apply_failed", message: error.message } : undefined,
      };
    } finally {
      this.deps.sessionOverrides.delete(sessionKey);
      await this.closeSessionQuietly(sessionKey);
    }
  }

  /**
   * 重跑一条已存在的计划：从存储读回计划记录与正文，校验存在性后置 ready，
   * 再交给共用管线执行。
   *
   * 与 `run()` 的差异**全部**在此前置内：计划与正文的来源是存储（`run` 来自
   * Phase 1 的 discovery 产出）、多一次存在性双校验、多一次 `status: "ready"`
   * 状态回落。此处的 state 读取时点也以本入口原有语义为准（在置 ready 之后）。
   */
  async rerunPlan(input: { planId: string; runId: string; startedAt: Date }): Promise<DiscoveryFireResult> {
    const { planId, runId, startedAt } = input;

    const planRecord = await this.deps.planStore.getRecord(planId);
    if (!planRecord) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: { code: "plan_not_found", message: `Plan ${planId} not found` },
      };
    }

    const planMarkdown = await this.deps.planStore.readPlanMarkdown(planId);
    if (!planMarkdown) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: { code: "plan_body_missing", message: `Plan markdown for ${planId} not found on disk` },
      };
    }

    await this.deps.planStore.updateStatus(planId, { status: "ready" });

    return this.runPipeline({
      runId,
      startedAt,
      planRecord,
      planMarkdown,
      state: await this.deps.stateStore.read(startedAt),
    });
  }

  /**
   * 首次触发：跑 Phase 1 discovery 产出计划，随后交给共用管线执行。
   *
   * 与 `rerunPlan()` 的差异**全部**在此前置内：计划与正文由 discovery 会话产出
   * （写入 `discoveryCtx.plan`）而非从存储读回；无计划或 discovery 失败时在本入口
   * 就地收尾（`markFailedNoPlan` / `no_plan`），不进入管线。
   */
  async run(input: DiscoveryFireRunInput): Promise<DiscoveryFireResult> {
    const { runId, startedAt } = input;

    const state = await this.deps.stateStore.read(startedAt);

    // 本入口在 Phase 1 结束时才知道计划是否存在，故此处只备「无计划」的
    // 历史基底（markFailedNoPlan / no_plan 两处用）；一旦拿到计划记录，
    // 后续落盘的历史基底由 runPipeline 自行构造（含 planId）。
    const prePlanHistory: DiscoveryRunHistoryEvent = {
      schemaVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      outcome: "no_plan",
    };

    // ── Phase 1: Discovery (bypassPermissions) ──
    this.emitEvent(runId, "discovery_started");
    const discoverySessionKey = DiscoveryFire.deriveDiscoverySessionKey(this.deps.projectKey, runId);

    const activeCycle = state.activeWorkCycleId
      ? await this.deps.cycleStore.getRecord(state.activeWorkCycleId)
      : undefined;
    const existingWorkspace =
      activeCycle && activeCycle.status === "active" && existsSync(activeCycle.workspace.cwd)
        ? {
            cwd: activeCycle.workspace.cwd,
            strategy: activeCycle.workspace.strategy,
            metadata: activeCycle.workspace.metadata,
          }
        : state.currentWorkspace && existsSync(state.currentWorkspace.cwd)
          ? state.currentWorkspace
          : undefined;

    const discoveryCtx: DiscoveryRunContext = {
      kind: "discovery",
      sessionKey: discoverySessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      startedAt,
      planStore: this.deps.planStore,
      planCallCount: 0,
    };
    this.deps.runContexts.register(discoveryCtx);
    this.deps.sessionOverrides.set(discoverySessionKey, {
      cwd: existingWorkspace?.cwd ?? this.deps.projectKey,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    const chatDigest = await buildChatDigest({
      projectRoot: this.deps.projectKey,
      pilotHome: this.deps.paths.pilotHome,
      maxSessions: 10,
      maxPromptsPerSession: 8,
      maxPromptLength: 500,
    });
    discoveryCtx.chatSessionAliases = chatDigest.aliasMap;

    const planIndex = await this.deps.planStore.readIndex();
    const existingPlans = planIndex.plans.map(p => ({
      id: p.id,
      title: p.title,
      dedupeKey: p.dedupeKey,
      status: p.status,
    }));

    let discoveryEvents: GatewayEvent[];
    try {
      discoveryEvents = await this.drainTurn({
        sessionKey: discoverySessionKey,
        channelKey: DISCOVERY_CHANNEL,
        runId: `${runId}.discovery`,
        message: buildDiscoveryPrompt({
          projectRoot: this.deps.projectKey,
          runId,
          createdAt: startedAt.toISOString(),
          chatDir: getPilotProjectChatDir(this.deps.projectKey, this.deps.paths.pilotHome),
          workspace: existingWorkspace
            ? { cwd: existingWorkspace.cwd, strategy: existingWorkspace.strategy }
            : undefined,
          chatDigest,
          existingPlans,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
    } finally {
      this.deps.runContexts.unregister(discoverySessionKey);
      this.deps.sessionOverrides.delete(discoverySessionKey);
      await this.closeSessionQuietly(discoverySessionKey);
    }

    const discoveryError = pickFirstError(discoveryEvents);
    if (discoveryError && !discoveryCtx.plan) {
      const finishedAt = this.deps.now();
      this.emitEvent(runId, "run_failed", {
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
        outcome: "failed",
      });
      await this.markFailedNoPlan(runId, discoveryError, finishedAt, prePlanHistory);
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: "",
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
      };
    }

    if (!discoveryCtx.plan) {
      this.emitEvent(runId, "no_plan", { outcome: "no_plan" });
      const finishedAt = this.deps.now();
      await this.deps.stateStore.markFireCompleted({
        outcome: "no_plan",
        runId,
        now: finishedAt,
      });
      if (this.deps.config.dormancy.enabled) {
        await this.deps.stateStore.setDormant(finishedAt);
      }
      await this.deps.reportStore.appendHistory({
        ...prePlanHistory,
        finishedAt: finishedAt.toISOString(),
        outcome: "no_plan",
      });
      return {
        outcome: "no_plan",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    }

    const planRecord = discoveryCtx.plan.record;
    this.emitEvent(runId, "plan_produced", { title: planRecord.title, planId: planRecord.id });

    return this.runPipeline({
      runId,
      startedAt,
      planRecord,
      planMarkdown: discoveryCtx.plan.markdown,
      state,
    });
  }

  /**
   * 阶段 2–4：workspace → execution → report → 写回 plan/state/history。
   *
   * `run()`（首次触发）与 `rerunPlan()`（重跑计划）共用这段管线，两者的差异
   * 全在进入本方法之前——`run` 多一段 Phase 1 discovery（产出计划记录与正文），
   * `rerunPlan` 多一段「从存储读回计划 + 校验存在性 + 置 ready」的前置，
   * 以及一个 state 读取时点。进入此处的是同一组输入。
   *
   * 副作用时序契约（勿改）：
   * - 每阶段的 session override / runContext 恒在 finally 中清理并关闭会话；
   * - 收尾落盘顺序恒为 plan.updateStatus → state.markFireCompleted → history.append；
   * - workspace 准备失败与 execution 出错两条路径落盘后立即返回，不进入后续阶段。
   */
  private async runPipeline(input: {
    runId: string;
    startedAt: Date;
    planRecord: DiscoveryPlanRecord;
    planMarkdown: string;
    state: AlwaysOnDiscoveryState;
  }): Promise<DiscoveryFireResult> {
    const { runId, startedAt, planRecord, planMarkdown, state } = input;
    const planId = planRecord.id;

    const baseHistory: DiscoveryRunHistoryEvent = {
      schemaVersion: 1,
      runId,
      planId,
      startedAt: startedAt.toISOString(),
      outcome: "no_plan",
    };

    // ── Phase 2: Workspace (bypassPermissions, agent-driven) ──
    this.emitEvent(runId, "workspace_started", { planId });
    let workspace: WorkspaceHandle;
    let workCycle: WorkCycleRecord;
    try {
      const wsResult = await this.runWorkspacePhase({ runId, state, planTitle: planRecord.title });
      workspace = wsResult.handle;
      workCycle = wsResult.cycle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const code = error instanceof AlwaysOnError ? error.code : "workspace_prepare_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent(runId, "run_failed", {
        planId,
        error: { code, message },
        outcome: "failed",
        telemetryPhase: "workspace",
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        planId,
        now: finishedAt,
      });
      await this.deps.reportStore.appendHistory({
        ...baseHistory,
        planId,
        outcome: "failed",
        finishedAt: finishedAt.toISOString(),
        error: { code, message },
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId,
        error: { code, message },
      };
    }

    this.assertWorkspaceCwdSafe(workspace);
    workspace.metadata.startedAt = startedAt.toISOString();
    this.emitEvent(runId, "workspace_ready", { planId });

    // ── Phase 3: Execution (bypassPermissions, plan only) ──
    const executionSessionKey = DiscoveryFire.deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(executionSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
      permissionRules: {
        deny: ALWAYS_ON_EXECUTION_DENY_RULES,
      },
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey: executionSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(planId, {
      status: "executing",
      workCycleId: workCycle.id,
    });
    await this.deps.cycleStore.addPlan(workCycle.id, planId);
    this.emitEvent(runId, "execution_started", { planId, title: planRecord.title });

    let executionError: { code?: string; message: string } | undefined;
    try {
      const events = await this.drainTurn({
        sessionKey: executionSessionKey,
        channelKey: EXECUTION_CHANNEL,
        runId: `${runId}.execute`,
        message: buildExecutionPrompt({
          plan: planRecord,
          planMarkdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      executionError = pickFirstError(events);
    } finally {
      this.deps.runContexts.unregister(executionSessionKey);
      this.deps.sessionOverrides.delete(executionSessionKey);
      await this.closeSessionQuietly(executionSessionKey);
    }

    if (executionError) {
      this.emitEvent(runId, "run_failed", {
        planId,
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
        outcome: "failed",
        telemetryPhase: "execution",
      });
      const finishedAt = this.deps.now();
      const reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: `execution_failed: ${executionError.message}`,
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
      await this.deps.planStore.updateStatus(planId, {
        status: "failed",
        reportFilePath,
        workCycleId: workCycle.id,
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        planId,
        now: finishedAt,
      });
      await this.deps.reportStore.appendHistory({
        ...baseHistory,
        planId,
        outcome: "failed",
        finishedAt: finishedAt.toISOString(),
        workCycleId: workCycle.id,
        workspace: { strategy: workspace.strategy, handle: workspace.cwd },
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId,
        workspace,
        reportFilePath,
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      };
    }

    this.emitEvent(runId, "execution_completed", { planId, title: planRecord.title });

    // ── Phase 4: Report (bypassPermissions, independent agent loop) ──
    this.emitEvent(runId, "report_started", { planId, title: planRecord.title });
    const reportSessionKey = DiscoveryFire.deriveReportSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(reportSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    const reportCtx: ReportRunContext = {
      kind: "report",
      sessionKey: reportSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(reportCtx);

    let reportEvents: GatewayEvent[] = [];
    let reportError: { code?: string; message: string } | undefined;
    try {
      reportEvents = await this.drainTurn({
        sessionKey: reportSessionKey,
        channelKey: REPORT_CHANNEL,
        runId: `${runId}.report`,
        message: buildReportPrompt({
          plan: planRecord,
          planMarkdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      reportError = pickFirstError(reportEvents);
    } finally {
      this.deps.runContexts.unregister(reportSessionKey);
      this.deps.sessionOverrides.delete(reportSessionKey);
      await this.closeSessionQuietly(reportSessionKey);
    }

    const finishedAt = this.deps.now();

    if (!reportCtx.report) {
      const assistantText = extractAssistantText(reportEvents);
      if (assistantText) {
        const metadata: ReportMetadata = {
          runId,
          planId,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          outcome: "executed",
          workspaceStrategy: workspace.strategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
          workspaceHandle: workspace.cwd,
        };
        const parsed = parseReportMarkdown(assistantText, metadata);
        const filePath = await this.deps.reportStore.writeReport(runId, parsed.rawContent);
        reportCtx.report = { markdown: parsed.rawContent, filePath, finishedAt };
      }
    }

    const reportDegraded = !reportCtx.report || !!reportError;
    const outcome: AlwaysOnDiscoveryOutcome = "executed";
    const planStatus = reportDegraded ? ("completed_no_report" as const) : ("completed" as const);

    if (!reportDegraded) {
      this.emitEvent(runId, "report_produced", { planId, title: planRecord.title, outcome });
    }
    this.emitEvent(runId, "run_completed", { planId, title: planRecord.title, outcome });

    let reportFilePath = reportCtx.report?.filePath;
    if (!reportCtx.report) {
      reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: reportError ? `report_failed: ${reportError.message}` : "report_tool_not_invoked",
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
    }

    await this.deps.planStore.updateStatus(planId, {
      status: planStatus,
      reportFilePath,
      workCycleId: workCycle.id,
    });
    await this.deps.stateStore.markFireCompleted({
      outcome,
      runId,
      planId,
      now: finishedAt,
    });
    await this.deps.reportStore.appendHistory({
      ...baseHistory,
      planId,
      outcome,
      finishedAt: finishedAt.toISOString(),
      workCycleId: workCycle.id,
      workspace: { strategy: workspace.strategy, handle: workspace.cwd },
      error: reportError ? { code: reportError.code ?? "report_degraded", message: reportError.message } : undefined,
    });

    return {
      outcome,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      planId,
      workspace,
      reportFilePath,
      error: reportError ? { code: reportError.code ?? "report_degraded", message: reportError.message } : undefined,
    };
  }

  /**
   * Phase 2: Ensure an isolated workspace exists for plan execution.
   *
   * The runtime decides deterministically whether to reuse an existing
   * workspace or create a new one — the agent loop is only started when
   * a fresh workspace is needed.
   */
  private async runWorkspacePhase(input: {
    runId: string;
    state: AlwaysOnDiscoveryState;
    planTitle: string;
  }): Promise<{ handle: WorkspaceHandle; cycle: WorkCycleRecord }> {
    const { runId, state, planTitle } = input;

    // ── Deterministic reuse check ──
    if (state.activeWorkCycleId) {
      const activeCycle = await this.deps.cycleStore.getRecord(state.activeWorkCycleId);
      if (activeCycle && activeCycle.status === "active" && existsSync(activeCycle.workspace.cwd)) {
        return {
          handle: {
            runId: activeCycle.createdByRunId,
            projectKey: this.deps.projectKey,
            strategy: activeCycle.workspace.strategy,
            cwd: activeCycle.workspace.cwd,
            metadata: { ...activeCycle.workspace.metadata },
          },
          cycle: activeCycle,
        };
      }
    }

    // ── No reusable workspace — start agent loop to create one ──
    const workspaceSessionKey = DiscoveryFire.deriveWorkspaceSessionKey(this.deps.projectKey, runId);

    const workspaceCtx: WorkspaceRunContext = {
      kind: "workspace",
      sessionKey: workspaceSessionKey,
      runId,
      planTitle,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspaceRegistry: this.deps.workspaceRegistry,
      stateStore: this.deps.stateStore,
      cycleStore: this.deps.cycleStore,
      now: this.deps.now,
    };
    this.deps.runContexts.register(workspaceCtx);
    this.deps.sessionOverrides.set(workspaceSessionKey, {
      cwd: this.deps.projectKey,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    try {
      await this.drainTurn({
        sessionKey: workspaceSessionKey,
        channelKey: WORKSPACE_CHANNEL,
        runId: `${runId}.workspace`,
        message: buildWorkspacePrompt({
          projectRoot: this.deps.projectKey,
          runId,
          planTitle,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
    } finally {
      this.deps.runContexts.unregister(workspaceSessionKey);
      this.deps.sessionOverrides.delete(workspaceSessionKey);
      await this.closeSessionQuietly(workspaceSessionKey);
    }

    const cycleId = this.deps.uuid();
    if (workspaceCtx.handle) {
      const cycle = await this.deps.cycleStore.create(workspaceCtx.handle, runId, cycleId, this.deps.now());
      await this.deps.stateStore.setActiveWorkCycleId(cycle.id, this.deps.now());
      return { handle: workspaceCtx.handle, cycle };
    }

    const ensured = await ensureActiveWorkCycle({
      state,
      projectKey: this.deps.projectKey,
      runId,
      planTitle,
      cycleId,
      workspaceRegistry: this.deps.workspaceRegistry,
      stateStore: this.deps.stateStore,
      cycleStore: this.deps.cycleStore,
      now: this.deps.now,
    });
    return { handle: ensured.handle, cycle: ensured.cycle };
  }

  private assertWorkspaceCwdSafe(workspace: WorkspaceHandle): void {
    if (workspace.cwd === this.deps.projectKey) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        "workspace cwd must not equal projectRoot — refusing to run Always-On turns in the project root.",
      );
    }
    const inWorktree = workspace.cwd.startsWith(this.deps.paths.worktreesDir);
    const inSnapshot = workspace.cwd.startsWith(this.deps.paths.snapshotsDir);
    if (!inWorktree && !inSnapshot) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        `workspace cwd ${workspace.cwd} is outside the configured Always-On workspace bases.`,
      );
    }
  }

  /**
   * 关闭常驻会话（清理路径）。失败只留日志、不上抛。
   *
   * 会话已无用时，关闭失败的后果是 fd / 会话状态残留——值得留痕，但不该中断
   * 落盘流程，更不该掩盖该阶段真正的错误（清理在 finally 中，上抛会顶掉原始异常）。
   * 本文件所有「关闭 always-on 会话」都收敛到这里，避免清理语义分叉。
   *
   * 注：`deps.logger` 自本方法起才有消费方——此前它被声明并被 AlwaysOnRuntime
   * 注入，却在整个文件里零引用（死接线）。
   */
  private async closeSessionQuietly(sessionKey: string): Promise<void> {
    await this.deps.gateway.closeSession({ sessionKey, reason: "always-on/done" }).catch(error => {
      this.deps.logger?.warn("always-on session close failed", {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async drainTurn(input: {
    sessionKey: string;
    channelKey: GatewayChannelKey;
    runId: string;
    message: string;
    mode: "default" | "bypassPermissions";
    /** When true, each event is appended to the run events log on disk. */
    persistEvents?: boolean;
  }): Promise<GatewayEvent[]> {
    const events: GatewayEvent[] = [];
    try {
      for await (const event of this.deps.gateway.submitTurn({
        sessionKey: input.sessionKey,
        channelKey: input.channelKey,
        message: input.message,
        mode: input.mode,
        runId: input.runId,
        projectKey: this.deps.projectKey,
        // 接线 alwaysOn.execution：限制单次 Always-On turn 的步数与墙钟时长，
        // 避免常驻后台执行失控（此前配置被解析但从未传递，属静默失效）。
        maxTurns: this.deps.config.execution.maxTurns,
        timeoutMs: this.deps.config.execution.timeoutMinutes * 60 * 1000,
        telemetry: {
          ownerModule: "always_on",
          executionKind: "always_on",
          phase: String(input.channelKey).startsWith("always-on/")
            ? String(input.channelKey).slice("always-on/".length)
            : undefined,
        },
      })) {
        events.push(event);
        this.deps.onTurnEvent?.(input.sessionKey, input.channelKey, event);
        if (input.persistEvents) {
          // 浅拷贝为普通记录（store 接口按 Record 解耦，不依赖 agent 事件类型）。
          await this.deps.reportStore.appendRunEvent(input.runId, { ...event }).catch(() => undefined);
        }
      }
    } finally {
      // turn 事件流结束（含异步迭代器异常中止）：关闭复用 fd 的写入器，
      // 与 CronFire 的 run 收尾语义对齐（未关闭时 store 内 TTL 兜底）。
      void this.deps.reportStore.closeRun(input.runId).catch(() => undefined);
    }
    return events;
  }

  private async writeFallbackReport(input: {
    runId: string;
    plan: DiscoveryPlanRecord;
    startedAt: string;
    finishedAt: string;
    reason: string;
    workspaceStrategy: string;
    workspaceHandle: string;
  }): Promise<string> {
    const metadata: ReportMetadata = {
      runId: input.runId,
      planId: input.plan.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: "failed",
      workspaceStrategy: input.workspaceStrategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
      workspaceHandle: input.workspaceHandle,
    };
    const markdown = buildFallbackReport({
      metadata,
      title: input.plan.title,
      reason: input.reason,
    });
    return this.deps.reportStore.writeReport(input.runId, markdown);
  }

  private async markFailedNoPlan(
    runId: string,
    error: { code?: string; message: string },
    finishedAt: Date,
    baseHistory: DiscoveryRunHistoryEvent,
  ): Promise<void> {
    await this.deps.stateStore.markFireCompleted({
      outcome: "failed",
      runId,
      now: finishedAt,
    });
    await this.deps.reportStore.appendHistory({
      ...baseHistory,
      outcome: "failed",
      finishedAt: finishedAt.toISOString(),
      error: { code: error.code ?? "discovery_failed", message: error.message },
    });
  }
}

export async function acquireDiscoveryLock(
  paths: AlwaysOnPaths,
  payload: { pid: number; startedAt: string; runId: string },
): Promise<boolean> {
  await mkdir(dirname(paths.discoveryLockFile), { recursive: true });
  try {
    await writeFile(paths.discoveryLockFile, JSON.stringify(payload, null, 2), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function releaseDiscoveryLock(paths: AlwaysOnPaths): Promise<void> {
  await unlink(paths.discoveryLockFile).catch(() => undefined);
}

function pickFirstError(events: GatewayEvent[]): { code?: string; message: string } | undefined {
  for (const event of events) {
    if (event.type === "error") {
      return { code: event.code, message: event.message };
    }
  }
  return undefined;
}

function extractAssistantText(events: GatewayEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant_text_delta") {
      text += event.text;
    }
  }
  return text.trim();
}
