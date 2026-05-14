import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../gateway/index.js";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import { buildFallbackReport, type ReportMetadata } from "../contracts/ReportContract.js";
import { AlwaysOnError } from "../protocol/errors.js";
import type {
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  DiscoveryFireResult,
  DiscoveryPlanRecord,
  DiscoveryRunHistoryEvent,
  WorkspaceHandle,
} from "../protocol/types.js";
import type { AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import type { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import type { AlwaysOnRunContextRegistry, ExecutionRunContext, DiscoveryRunContext } from "./AlwaysOnRunContextRegistry.js";
import { buildDiscoveryPrompt, buildExecutionPrompt } from "./discoveryPrompts.js";
import type { SessionConfigOverrides } from "./SessionConfigOverrides.js";

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
  reportStore: DiscoveryReportStore;
  uuid: () => string;
  now: () => Date;
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void };
};

export type DiscoveryFireRunInput = {
  /** Pre-allocated runId (already used by the lock + state store). */
  runId: string;
  startedAt: Date;
};

const DISCOVERY_CHANNEL: GatewayChannelKey = "always-on/discovery";
const EXECUTION_CHANNEL: GatewayChannelKey = "always-on/execute";

export type EnsureAlwaysOnWorkspaceInput = {
  state: AlwaysOnDiscoveryState;
  projectKey: string;
  runId: string;
  workspaceRegistry: WorkspaceProviderRegistry;
  stateStore: DiscoveryStateStore;
  now: () => Date;
  fileExists?: (path: string) => boolean;
};

export type EnsureAlwaysOnWorkspaceResult = {
  handle: WorkspaceHandle;
  reused: boolean;
};

/**
 * Look up the project's persistent isolated workspace from
 * `state.currentWorkspace`. If it still exists on disk, return a reconstructed
 * `WorkspaceHandle`. Otherwise prepare a new one via the provider registry and
 * persist the handle into state. Always-On runs at most one workspace per
 * project; this function is the single source of truth for that invariant.
 */
export async function ensureAlwaysOnWorkspace(
  input: EnsureAlwaysOnWorkspaceInput,
): Promise<EnsureAlwaysOnWorkspaceResult> {
  const fileExists = input.fileExists ?? existsSync;
  const ref = input.state.currentWorkspace;
  if (ref && fileExists(ref.cwd)) {
    return {
      handle: {
        runId: ref.runId,
        projectKey: input.projectKey,
        strategy: ref.strategy,
        cwd: ref.cwd,
        metadata: { ...ref.metadata },
      },
      reused: true,
    };
  }

  const prepared = await input.workspaceRegistry.prepare({
    projectRoot: input.projectKey,
    runId: input.runId,
  });
  await input.stateStore.setCurrentWorkspace(prepared.handle, input.now());
  return { handle: prepared.handle, reused: false };
}

export class DiscoveryFire {
  constructor(private readonly deps: DiscoveryFireDependencies) {}

  static deriveDiscoverySessionKey(projectKey: string, runId: string): string {
    return `always-on/discovery:project=${projectKey}:run=${runId}`;
  }

  static deriveExecutionSessionKey(projectKey: string, runId: string): string {
    return `always-on/execute:project=${projectKey}:run=${runId}`;
  }

  async run(input: DiscoveryFireRunInput): Promise<DiscoveryFireResult> {
    const { runId, startedAt } = input;
    const discoverySessionKey = DiscoveryFire.deriveDiscoverySessionKey(this.deps.projectKey, runId);

    const state = await this.deps.stateStore.read(startedAt);

    const baseHistory: DiscoveryRunHistoryEvent = {
      schemaVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      outcome: "no_plan",
    };

    let workspace: WorkspaceHandle;
    try {
      const ensured = await ensureAlwaysOnWorkspace({
        state,
        projectKey: this.deps.projectKey,
        runId,
        workspaceRegistry: this.deps.workspaceRegistry,
        stateStore: this.deps.stateStore,
        now: this.deps.now,
      });
      workspace = ensured.handle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const code = error instanceof AlwaysOnError ? error.code : "workspace_prepare_failed";
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        now: finishedAt,
      });
      await this.deps.reportStore.appendHistory({
        ...baseHistory,
        outcome: "failed",
        finishedAt: finishedAt.toISOString(),
        error: { code, message },
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: "",
        error: { code, message },
      };
    }

    this.assertWorkspaceCwdSafe(workspace);
    workspace.metadata.startedAt = startedAt.toISOString();

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
      cwd: workspace.cwd,
      permissionMode: "default",
      bypassAvailable: true,
      canPrompt: false,
    });

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
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          chatDir: getPilotProjectChatDir(this.deps.projectKey, this.deps.paths.pilotHome),
        }),
        mode: "default",
      });
    } finally {
      this.deps.runContexts.unregister(discoverySessionKey);
      this.deps.sessionOverrides.delete(discoverySessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: discoverySessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const discoveryError = pickFirstError(discoveryEvents);
    if (discoveryError && !discoveryCtx.plan) {
      const finishedAt = this.deps.now();
      await this.markFailedNoPlan(runId, discoveryError, finishedAt, baseHistory);
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
        ...baseHistory,
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
    const executionSessionKey = DiscoveryFire.deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(executionSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey: executionSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(planRecord.id, {
      status: "executing",
      workspace: { strategy: workspace.strategy, handle: workspace.cwd, cwd: workspace.cwd },
    });

    let executionError: { code?: string; message: string } | undefined;
    try {
      const events = await this.drainTurn({
        sessionKey: executionSessionKey,
        channelKey: EXECUTION_CHANNEL,
        runId: `${runId}.execute`,
        message: buildExecutionPrompt({
          plan: planRecord,
          planMarkdown: discoveryCtx.plan.markdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      executionError = pickFirstError(events);
    } finally {
      this.deps.runContexts.unregister(executionSessionKey);
      this.deps.sessionOverrides.delete(executionSessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: executionSessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const finishedAt = this.deps.now();
    let outcome: AlwaysOnDiscoveryOutcome = executionCtx.report ? "executed" : "failed";
    if (executionError) outcome = "failed";

    let reportFilePath = executionCtx.report?.filePath;
    if (!executionCtx.report) {
      reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: executionError
          ? `execution_failed: ${executionError.message}`
          : "report_tool_not_invoked",
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
    }

    await this.deps.planStore.updateStatus(planRecord.id, {
      status: outcome === "executed" ? "completed" : "failed",
      reportFilePath,
      workspace: { strategy: workspace.strategy, handle: workspace.cwd, cwd: workspace.cwd },
    });
    await this.deps.stateStore.markFireCompleted({
      outcome,
      runId,
      planId: planRecord.id,
      now: finishedAt,
    });
    await this.deps.reportStore.appendHistory({
      ...baseHistory,
      planId: planRecord.id,
      outcome,
      finishedAt: finishedAt.toISOString(),
      workspace: { strategy: workspace.strategy, handle: workspace.cwd },
      error: executionError ? { code: executionError.code ?? "execution_failed", message: executionError.message } : undefined,
    });

    // Workspace is intentionally retained across fires; user removes the dir
    // manually to reset the scratchpad. provider.dispose is never called.

    return {
      outcome,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      planId: planRecord.id,
      workspace,
      reportFilePath,
      error: executionError ? { code: executionError.code ?? "execution_failed", message: executionError.message } : undefined,
    };
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
    for await (const event of this.deps.gateway.submitTurn({
      sessionKey: input.sessionKey,
      channelKey: input.channelKey,
      message: input.message,
      mode: input.mode,
      runId: input.runId,
      projectKey: this.deps.projectKey,
    })) {
      events.push(event);
      if (input.persistEvents) {
        await this.deps.reportStore
          .appendRunEvent(input.runId, event as unknown as Record<string, unknown>)
          .catch(() => undefined);
      }
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
