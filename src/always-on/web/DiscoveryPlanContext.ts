/**
 * Discovery context aggregation.
 *
 * Extracted from `ui/server/discovery-plans.js`
 * `getProjectDiscoveryContext`. Collects workspace signals (git),
 * memory file summaries, existing plans, cron job overviews, and
 * recent chat sessions into a single snapshot consumed by the
 * Always-On discovery phase.
 *
 * All I/O is injectable so tests can substitute stubs.
 */

import { spawn } from "node:child_process";
import { normalizeString, toIsoTimestamp, toTimestampValue, truncateText } from "./DiscoveryPlanStatus.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 7;
const MAX_ITEMS = 8;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type DiscoveryContextDeps = {
  projectName: string;
  projectRoot: string;
  getProjectCronJobsOverview: (projectName: string) => Promise<{ jobs: CronJobOverview[] }>;
  getSessions: (projectName: string, limit: number, offset: number) => Promise<{ sessions: SessionRecord[] }>;
  extractProjectDirectory: (name: string) => Promise<string>;
};

type CronJobOverview = {
  id: string;
  status: string;
  cron: string;
  recurring: boolean;
  manualOnly: boolean;
  prompt: string;
  latestRun?: { summary?: string } | null;
};

type SessionRecord = Record<string, unknown> & {
  id?: string;
  sessionKind?: string;
  lastActivity?: string;
  updated_at?: string;
  createdAt?: string;
  created_at?: string;
  summary?: string;
  title?: string;
  name?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function buildDiscoveryContext(deps: DiscoveryContextDeps) {
  const { projectName, projectRoot } = deps;
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const [workspaceSignals, cronOverview, sessionResult] = await Promise.all([
    collectWorkspaceSignals(projectRoot),
    deps.getProjectCronJobsOverview(projectName).catch(() => ({ jobs: [] as CronJobOverview[] })),
    deps.getSessions(projectName, Number.MAX_SAFE_INTEGER, 0).catch(() => ({ sessions: [] as SessionRecord[] })),
  ]);

  const recentChats = Array.isArray(sessionResult?.sessions)
    ? sessionResult.sessions
        .filter(s => s?.sessionKind !== "background_task")
        .filter(
          s => (toTimestampValue(s?.lastActivity || s?.updated_at || s?.createdAt || s?.created_at) ?? 0) >= cutoff,
        )
        .sort(
          (a, b) =>
            (toTimestampValue(b?.lastActivity || b?.updated_at || b?.createdAt || b?.created_at) ?? 0) -
            (toTimestampValue(a?.lastActivity || a?.updated_at || a?.createdAt || a?.created_at) ?? 0),
        )
        .slice(0, MAX_ITEMS)
        .map(buildRecentChatEntry)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    workspace: { projectName, projectRoot, signals: workspaceSignals },
    memory: [],
    existingPlans: [] as unknown[],
    cronJobs: Array.isArray(cronOverview?.jobs) ? cronOverview.jobs.slice(0, MAX_ITEMS).map(buildCronContextItem) : [],
    recentChats,
  };
}

// ---------------------------------------------------------------------------
// Workspace signal collection
// ---------------------------------------------------------------------------

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise(done => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => done(""));
    child.on("close", code => done(code === 0 ? stdout.trim() : ""));
  });
}

async function collectWorkspaceSignals(projectRoot: string): Promise<string[]> {
  const [gitStatus, recentCommit] = await Promise.all([
    runCommand("git", ["-C", projectRoot, "status", "--short"], projectRoot),
    runCommand("git", ["-C", projectRoot, "log", "-1", "--stat", "--oneline", "--decorate=no"], projectRoot),
  ]);

  const signals: string[] = [];
  signals.push(`Project root: ${projectRoot}`);
  if (gitStatus) {
    signals.push(`Git status:\n${gitStatus.split("\n").slice(0, 20).join("\n")}`);
  }
  if (recentCommit) {
    signals.push(`Latest commit:\n${recentCommit.split("\n").slice(0, 12).join("\n")}`);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Memory signal collection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

function summarizeSession(session: SessionRecord | null | undefined): string {
  const summary = normalizeString(
    session?.summary || session?.title || session?.name || session?.lastUserMessage || session?.lastAssistantMessage,
  );
  return truncateText(summary, 200);
}

function buildRecentChatEntry(session: SessionRecord) {
  return {
    id: session.id,
    summary: summarizeSession(session),
    lastActivity: toIsoTimestamp(session.lastActivity || session.updated_at || session.createdAt || session.created_at),
    lastUserMessage: truncateText(session.lastUserMessage, 220),
    lastAssistantMessage: truncateText(session.lastAssistantMessage, 220),
  };
}

function buildCronContextItem(job: CronJobOverview) {
  return {
    id: job.id,
    status: job.status,
    cron: job.cron,
    recurring: Boolean(job.recurring),
    manualOnly: Boolean(job.manualOnly),
    prompt: truncateText(job.prompt, 180),
    latestRunSummary: truncateText(job.latestRun?.summary, 180),
  };
}
