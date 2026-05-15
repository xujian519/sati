/**
 * Discovery plan lifecycle service.
 *
 * Extracted from `ui/server/discovery-plans.js`. Owns:
 *   - plan store read/write/normalize
 *   - queue / update / archive operations (with guards)
 *   - run event + log emission
 *   - overview building
 *
 * Depends on injectable I/O adapters so tests can substitute stubs.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { generateWorkspaceDiff, type WorkspaceDiff } from "../workspace/WorkspaceApply.js";
import {
  computeExecutionStatus,
  computePlanStatus,
  normalizeString,
  normalizeStringList,
  pickLatestIsoTimestamp,
  sortDiscoveryPlans,
  toIsoTimestamp,
  toTimestampValue,
  truncateText,
  type WebPlanContextRefs,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

// Re-export so callers only need one import for the full service.
export {
  computeExecutionStatus,
  computePlanStatus,
  sortDiscoveryPlans,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_VERSION = 1;
const STRUCTURE_VERSION = 1;

type PlanIndex = {
  version: number;
  plans: WebPlanRecord[];
};

const EMPTY_STORE: PlanIndex = { version: INDEX_VERSION, plans: [] };

// ---------------------------------------------------------------------------
// Dependencies — callers inject these so the service stays testable
// ---------------------------------------------------------------------------

/** Emits run-history events + run log lines. */
export type RunEventSink = {
  appendRunEvent(
    projectRoot: string,
    event: Record<string, unknown>,
  ): Promise<unknown>;
  appendRunLog(
    projectRoot: string,
    runId: string,
    lines: string[],
  ): Promise<void>;
  appendRunLogEvent(
    projectRoot: string,
    runId: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  formatLogLine(entry: Record<string, unknown>): string;
};

export type ProjectPathResolver = {
  /** Resolve a display-name / encoded project name to the absolute root. */
  extractProjectDirectory(projectName: string): Promise<string>;
};

export type SessionActivityChecker = {
  isSessionActive(sessionId: string): boolean;
};

export type SessionLister = {
  getSessions(
    projectName: string,
    limit: number,
    offset: number,
  ): Promise<{ sessions: Array<Record<string, unknown>> }>;
};

export type WorkspaceManager = {
  applyWorktreeChanges(
    workspaceCwd: string,
    projectRoot: string,
  ): Promise<{ applied: boolean; diff?: string; error?: string }>;
  disposeWorkspace(
    strategy: string,
    cwd: string,
    projectRoot: string,
  ): Promise<void>;
};

export type DiscoveryPlanServiceDeps = {
  pilotHome: string;
  createProjectId: (projectRoot: string) => string;
  paths: ProjectPathResolver;
  sessions: SessionLister;
  activity: SessionActivityChecker;
  events: RunEventSink;
  workspace?: WorkspaceManager;
};

// ---------------------------------------------------------------------------
// Paths (mirrors ui/server/discovery-plans.js helpers)
// ---------------------------------------------------------------------------

function resolveProjectDir(pilotHome: string, createProjectId: (root: string) => string, projectRoot: string): string {
  const projectId = createProjectId(resolve(projectRoot));
  return join(pilotHome, "always-on", "projects", projectId);
}

function indexPath(projectDir: string): string {
  return join(projectDir, "plans", "index.json");
}

function planMarkdownDir(projectDir: string): string {
  return join(projectDir, "plans");
}

function relativePlanPath(planId: string): string {
  return join("plans", `${planId}.md`);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function createEmptyContextRefs(): WebPlanContextRefs {
  return {
    workingDirectory: [],
    memory: [],
    existingPlans: [],
    cronJobs: [],
    recentChats: [],
  };
}

export function normalizeDiscoveryPlanRecord(record: Record<string, unknown> | null | undefined): WebPlanRecord {
  const now = new Date().toISOString();
  const rawContextRefs =
    record?.contextRefs && typeof record.contextRefs === "object" && !Array.isArray(record.contextRefs)
      ? (record.contextRefs as Record<string, unknown>)
      : null;
  const contextRefs: WebPlanContextRefs = rawContextRefs
    ? {
        workingDirectory: normalizeStringList(rawContextRefs.workingDirectory),
        memory: normalizeStringList(rawContextRefs.memory),
        existingPlans: normalizeStringList(rawContextRefs.existingPlans),
        cronJobs: normalizeStringList(rawContextRefs.cronJobs),
        recentChats: normalizeStringList(rawContextRefs.recentChats),
      }
    : createEmptyContextRefs();

  const fallbackId = `plan-${randomUUID().slice(0, 8)}`;
  const id = normalizeString(record?.id, fallbackId);
  const sourceId = normalizeString(
    (record?.sourceDiscoverySessionId as string) || (record?.sourceRunId as string),
  );
  const gatewayStatus = normalizeString(record?.status, "ready");
  const mappedStatus =
    gatewayStatus === "executing" ? "running" :
    gatewayStatus === "superseded" ? "archived" :
    gatewayStatus;

  return {
    id,
    title: normalizeString(record?.title, "Untitled discovery plan"),
    createdAt: toIsoTimestamp(record?.createdAt as string) || now,
    updatedAt: toIsoTimestamp((record?.updatedAt as string) || (record?.createdAt as string)) || now,
    approvalMode: record?.approvalMode === "manual" ? "manual" : "auto",
    status: mappedStatus,
    summary: normalizeString(record?.summary),
    rationale: normalizeString(record?.rationale),
    dedupeKey: normalizeString(record?.dedupeKey, id),
    sourceDiscoverySessionId: sourceId,
    executionSessionId: normalizeString(record?.executionSessionId),
    executionStartedAt: toIsoTimestamp(record?.executionStartedAt as string),
    executionLastActivityAt: toIsoTimestamp(record?.executionLastActivityAt as string),
    executionStatus: normalizeString(record?.executionStatus),
    latestSummary: normalizeString(record?.latestSummary),
    contextRefs,
    planFilePath: normalizeString(record?.planFilePath, relativePlanPath(id)),
    structureVersion:
      typeof record?.structureVersion === "number" ? record.structureVersion : STRUCTURE_VERSION,
    workspace: normalizeWorkspaceRef(record?.workspace),
  };
}

function normalizeWorkspaceRef(
  raw: unknown,
): { strategy: string; cwd: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const strategy = typeof obj.strategy === "string" ? obj.strategy : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
  if (!strategy || !cwd) return undefined;
  return { strategy, cwd };
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

async function readPlanStore(projectDir: string): Promise<PlanIndex> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.plans)) {
      return { ...EMPTY_STORE };
    }
    const version =
      typeof parsed.schemaVersion === "number"
        ? parsed.schemaVersion
        : typeof parsed.version === "number"
          ? parsed.version
          : INDEX_VERSION;
    return {
      version,
      plans: (parsed.plans as unknown[]).map((p) => normalizeDiscoveryPlanRecord(p as Record<string, unknown>)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...EMPTY_STORE };
    }
    throw error;
  }
}

async function writePlanStore(projectDir: string, store: PlanIndex): Promise<void> {
  await fs.mkdir(planMarkdownDir(projectDir), { recursive: true });
  await fs.writeFile(
    indexPath(projectDir),
    `${JSON.stringify({ schemaVersion: INDEX_VERSION, plans: store.plans }, null, 2)}\n`,
    "utf8",
  );
}

async function readPlanBody(projectDir: string, planFilePath: string): Promise<string> {
  const absolutePath = isAbsolute(planFilePath) ? planFilePath : resolve(projectDir, planFilePath);
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Overview building
// ---------------------------------------------------------------------------

function buildOverview(
  plan: WebPlanRecord,
  content: string,
  session: WebPlanSession,
  isSessionActive: (id: string) => boolean,
) {
  const status = computePlanStatus(plan, session, isSessionActive);
  const latestSummary = normalizeString(
    session?.lastAssistantMessage || session?.summary || session?.title || plan.latestSummary,
  );
  return {
    ...plan,
    status,
    executionStatus: computeExecutionStatus(plan, session, isSessionActive) || undefined,
    executionStartedAt:
      pickLatestIsoTimestamp(plan.executionStartedAt, session?.createdAt, session?.created_at) || undefined,
    executionLastActivityAt:
      pickLatestIsoTimestamp(plan.executionLastActivityAt, session?.lastActivity, session?.updated_at) || undefined,
    latestSummary: latestSummary || undefined,
    workspace: plan.workspace,
    content: content.trim(),
  };
}

function buildExecutionPrompt(plan: WebPlanRecord, planContent: string, projectName: string): string {
  return [
    `Always-On execution for project "${projectName}".`,
    "",
    "This plan is already approved.",
    "Execute the work directly.",
    "Do not enter Plan Mode.",
    "Do not create a second mini-plan before acting.",
    "",
    `Plan ID: ${plan.id}`,
    `Plan file: ${plan.planFilePath}`,
    "",
    "Approved plan:",
    "",
    planContent.trim(),
  ].join("\n");
}

function buildApplyPrompt(
  plan: WebPlanRecord,
  projectName: string,
  projectRoot: string,
  diff: WorkspaceDiff,
): string {
  const header = [
    `Always-On apply for project "${projectName}".`,
    "",
    "Your job is to merge changes from the isolated workspace into the project root.",
    "Apply each change carefully using Edit or Write tools.",
    "If a file in the project root has been modified since the plan was executed,",
    "merge both sets of changes intelligently — do not blindly overwrite.",
    "If you cannot resolve a conflict, leave standard conflict markers (<<<< / ==== / >>>>).",
    "",
    "Do not enter Plan Mode.",
    "Do not create a new plan — apply the existing changes directly.",
    "",
    `Plan: "${plan.title}" (${plan.id})`,
    `Project root: ${projectRoot}`,
  ];

  if (plan.workspace?.cwd) {
    header.push(`Isolated workspace: ${plan.workspace.cwd} (${plan.workspace.strategy})`);
  }

  header.push("");

  if (!diff.diff.trim()) {
    header.push("No differences detected in the workspace. Nothing to apply.");
    return header.join("\n");
  }

  if (diff.truncated) {
    header.push(
      `The diff is large (${diff.fileCount} files) and has been truncated.`,
      "Read the relevant files from the workspace directory to compare and apply.",
      "",
      "Truncated diff (first portion):",
      "",
      diff.diff,
    );
  } else {
    header.push(
      `Changes (${diff.fileCount} file${diff.fileCount === 1 ? "" : "s"}):`,
      "",
      diff.diff,
    );
  }

  return header.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DiscoveryPlanService {
  private readonly deps: DiscoveryPlanServiceDeps;

  constructor(deps: DiscoveryPlanServiceDeps) {
    this.deps = deps;
  }

  private projectDir(projectRoot: string): string {
    return resolveProjectDir(this.deps.pilotHome, this.deps.createProjectId, projectRoot);
  }

  async getPlansOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    if (store.plans.length === 0) return { plans: [] };

    const sessionResult = await this.deps.sessions
      .getSessions(projectName, Number.MAX_SAFE_INTEGER, 0)
      .catch(() => ({ sessions: [] }));
    const sessionsById = new Map<string, Record<string, unknown>>();
    if (Array.isArray(sessionResult?.sessions)) {
      for (const s of sessionResult.sessions) {
        if (s.id) sessionsById.set(s.id as string, s);
      }
    }

    const isActive = (id: string) => this.deps.activity.isSessionActive(id);
    const plans = await Promise.all(
      store.plans.map(async (plan) => {
        const body = await readPlanBody(projectDir, plan.planFilePath);
        const session = plan.executionSessionId
          ? (sessionsById.get(plan.executionSessionId) as WebPlanSession) || null
          : null;
        return buildOverview(plan, body, session, isActive);
      }),
    );

    return { plans: sortDiscoveryPlans(plans) };
  }

  async queueExecution(projectName: string, planId: string, options: { source?: string } = {}) {
    const source = options.source ?? "manual";
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    const index = store.plans.findIndex((p) => p.id === planId);
    if (index === -1) throw makeError("Discovery plan not found", "NOT_FOUND");

    const plan = store.plans[index]!;
    if (plan.status === "archived" || plan.status === "applied") {
      throw makeError("Archived or applied discovery plans cannot be executed", "INVALID_STATE");
    }
    const isActive = (id: string) => this.deps.activity.isSessionActive(id);
    const execStatus = computeExecutionStatus(plan, null, isActive);
    if (execStatus === "running" || execStatus === "queued") {
      throw makeError("Discovery plan is already queued or running", "ALREADY_RUNNING");
    }
    const content = await readPlanBody(projectDir, plan.planFilePath);
    if (!normalizeString(content)) {
      throw makeError("Discovery plan content is missing", "MISSING_PLAN_BODY");
    }

    const now = new Date().toISOString();
    const executionToken = randomUUID();
    const updated: WebPlanRecord = {
      ...plan,
      status: "queued",
      executionStatus: "queued",
      executionSessionId: "",
      executionStartedAt: "",
      executionLastActivityAt: "",
      latestSummary: "",
      updatedAt: now,
      lastExecutionSource: source,
    };
    store.plans[index] = updated;
    await writePlanStore(projectDir, store);

    await this.deps.events.appendRunEvent(projectRoot, {
      runId: executionToken,
      kind: "plan",
      sourceId: updated.id,
      title: updated.title,
      status: "queued",
      timestamp: now,
      startedAt: now,
      metadata: { planId: updated.id, planFilePath: updated.planFilePath, source },
    });
    await this.deps.events.appendRunLog(projectRoot, executionToken, [
      this.deps.events.formatLogLine({
        timestamp: now,
        runId: executionToken,
        planId: updated.id,
        phase: "queued",
        message: `Queued plan "${updated.title}" from ${source}`,
      }),
      this.deps.events.formatLogLine({
        timestamp: now,
        runId: executionToken,
        planId: updated.id,
        phase: "plan_file",
        message: `Plan file: ${updated.planFilePath}`,
      }),
    ]);
    await this.deps.events.appendRunLogEvent(projectRoot, executionToken, {
      kind: "plan",
      planId: updated.id,
      phase: "queued",
      status: "queued",
      source,
      planFilePath: updated.planFilePath,
    });

    return {
      plan: buildOverview(updated, content, null, isActive),
      sessionSummary: `Always-On: ${updated.title}`,
      command: buildExecutionPrompt(updated, content, projectName),
      executionToken,
      workspaceCwd: plan.workspace?.cwd,
    };
  }

  async updateExecution(projectName: string, planId: string, updates: Record<string, unknown> = {}) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    const index = store.plans.findIndex((p) => p.id === planId);
    if (index === -1) throw makeError("Discovery plan not found", "NOT_FOUND");

    const plan = store.plans[index]!;
    const now = new Date().toISOString();
    const nextPlan: WebPlanRecord = {
      ...plan,
      executionSessionId: normalizeString(updates.executionSessionId, plan.executionSessionId),
      executionStartedAt: updates.executionStartedAt
        ? toIsoTimestamp(updates.executionStartedAt as string)
        : normalizeString(updates.status) === "running" && !plan.executionStartedAt
          ? now
          : plan.executionStartedAt,
      executionLastActivityAt: updates.executionLastActivityAt
        ? toIsoTimestamp(updates.executionLastActivityAt as string)
        : now,
      executionStatus: normalizeString(updates.status, plan.executionStatus),
      latestSummary: normalizeString(updates.latestSummary, plan.latestSummary),
      status: normalizeString(updates.status) ? normalizeString(updates.status) : plan.status,
      updatedAt: now,
    };

    store.plans[index] = nextPlan;
    await writePlanStore(projectDir, store);

    const executionRunId = normalizeString(
      updates.executionToken as string,
      nextPlan.executionSessionId || plan.executionSessionId || nextPlan.id,
    );
    const normalizedStatus = normalizeString(updates.status, nextPlan.executionStatus || nextPlan.status);
    if (executionRunId && normalizedStatus) {
      await this.deps.events.appendRunEvent(projectRoot, {
        runId: executionRunId,
        kind: "plan",
        sourceId: nextPlan.id,
        title: nextPlan.title,
        status: normalizedStatus,
        timestamp: now,
        startedAt: nextPlan.executionStartedAt || now,
        finishedAt:
          normalizedStatus === "completed" || normalizedStatus === "failed" ? now : undefined,
        sessionId: nextPlan.executionSessionId,
        output: nextPlan.latestSummary,
        metadata: { planId: nextPlan.id, planFilePath: nextPlan.planFilePath },
      });
      const logLines = [
        this.deps.events.formatLogLine({
          timestamp: now,
          level: normalizedStatus === "failed" ? "error" : "info",
          runId: executionRunId,
          planId: nextPlan.id,
          phase: normalizedStatus,
          message: `Plan execution ${normalizedStatus}`,
        }),
        nextPlan.latestSummary
          ? this.deps.events.formatLogLine({
              timestamp: now,
              runId: executionRunId,
              planId: nextPlan.id,
              phase: "summary",
              message: nextPlan.latestSummary,
            })
          : "",
      ].filter(Boolean);
      await this.deps.events.appendRunLog(projectRoot, executionRunId, logLines);
      await this.deps.events.appendRunLogEvent(projectRoot, executionRunId, {
        kind: "plan",
        planId: nextPlan.id,
        phase: normalizedStatus,
        status: normalizedStatus,
        sessionId: nextPlan.executionSessionId,
      });
    }

    // When an apply session completes, finalize the plan status and
    // dispose the workspace.
    if (
      plan.status === "applying" &&
      (normalizedStatus === "completed" || normalizedStatus === "failed")
    ) {
      const finalStatus = normalizedStatus === "completed" ? "applied" : "failed";

      if (finalStatus === "applied" && nextPlan.workspace?.cwd && this.deps.workspace) {
        try {
          await this.deps.workspace.disposeWorkspace(
            nextPlan.workspace.strategy,
            nextPlan.workspace.cwd,
            projectRoot,
          );
        } catch {
          // Best effort cleanup.
        }
      }

      const finalPlan: WebPlanRecord = {
        ...nextPlan,
        status: finalStatus,
        ...(finalStatus === "applied" ? { workspace: undefined } : {}),
        updatedAt: new Date().toISOString(),
      };
      store.plans[index] = finalPlan;
      await writePlanStore(projectDir, store);

      const isActive = (id: string) => this.deps.activity.isSessionActive(id);
      const content = await readPlanBody(projectDir, finalPlan.planFilePath);
      return buildOverview(finalPlan, content, null, isActive);
    }

    const isActive = (id: string) => this.deps.activity.isSessionActive(id);
    const content = await readPlanBody(projectDir, nextPlan.planFilePath);
    return buildOverview(nextPlan, content, null, isActive);
  }

  /**
   * Archive a plan and dispose its isolated workspace (if any).
   */
  async archive(projectName: string, planId: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    const index = store.plans.findIndex((p) => p.id === planId);
    if (index === -1) throw makeError("Discovery plan not found", "NOT_FOUND");

    const plan = store.plans[index]!;
    const isActive = (id: string) => this.deps.activity.isSessionActive(id);
    const execStatus = computeExecutionStatus(plan, null, isActive);
    if (execStatus === "running" || execStatus === "queued") {
      throw makeError("Running discovery plans cannot be archived", "INVALID_STATE");
    }

    if (plan.workspace?.cwd && this.deps.workspace) {
      try {
        await this.deps.workspace.disposeWorkspace(
          plan.workspace.strategy,
          plan.workspace.cwd,
          projectRoot,
        );
      } catch {
        // Best effort — workspace may already be gone.
      }
    }

    store.plans[index] = {
      ...plan,
      status: "archived",
      workspace: undefined,
      updatedAt: new Date().toISOString(),
    };
    await writePlanStore(projectDir, store);
    return { archived: true };
  }

  /**
   * Queue an apply session: generate the workspace diff, build a prompt
   * for the agent to merge changes into the project root, and return a
   * payload the frontend can use to launch a visible agent session.
   */
  async queueApply(projectName: string, planId: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    const index = store.plans.findIndex((p) => p.id === planId);
    if (index === -1) throw makeError("Discovery plan not found", "NOT_FOUND");

    const plan = store.plans[index]!;
    const isActive = (id: string) => this.deps.activity.isSessionActive(id);
    const planStatus = computePlanStatus(plan, null, isActive);

    if (planStatus !== "completed") {
      throw makeError(
        `Plan must be in completed status to apply (current: ${planStatus})`,
        "INVALID_STATE",
      );
    }

    if (!plan.workspace?.cwd) {
      throw makeError(
        "Plan has no associated workspace to apply",
        "MISSING_WORKSPACE",
      );
    }

    const diff = await generateWorkspaceDiff(
      plan.workspace.strategy,
      plan.workspace.cwd,
      projectRoot,
    );

    const now = new Date().toISOString();
    const executionToken = randomUUID();
    const content = await readPlanBody(projectDir, plan.planFilePath);

    const updated: WebPlanRecord = {
      ...plan,
      status: "applying",
      executionStatus: "queued",
      executionSessionId: "",
      executionStartedAt: "",
      executionLastActivityAt: "",
      latestSummary: "",
      updatedAt: now,
      lastExecutionSource: "apply",
    };
    store.plans[index] = updated;
    await writePlanStore(projectDir, store);

    await this.deps.events.appendRunEvent(projectRoot, {
      runId: executionToken,
      kind: "plan-apply",
      sourceId: updated.id,
      title: `Apply: ${updated.title}`,
      status: "queued",
      timestamp: now,
      startedAt: now,
      metadata: { planId: updated.id, source: "apply" },
    });

    return {
      plan: buildOverview(updated, content, null, isActive),
      sessionSummary: `Apply: ${updated.title}`,
      command: buildApplyPrompt(updated, projectName, projectRoot, diff),
      executionToken,
    };
  }

  /**
   * Low-level store reader — used by context aggregation.
   */
  async readStore(projectName: string): Promise<PlanIndex> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    return readPlanStore(this.projectDir(projectRoot));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
