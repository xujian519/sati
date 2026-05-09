import { resolve } from "node:path";
import { createProjectId } from "../../polit/paths.js";

const ROOT_DIR_NAME = "always-on";

export type AlwaysOnPaths = {
  politHome: string;
  projectKey: string;
  projectId: string;
  rootDir: string;
  projectDir: string;
  stateFile: string;
  plansDir: string;
  planIndexFile: string;
  reportsDir: string;
  runsDir: string;
  runHistoryFile: string;
  locksDir: string;
  discoveryLockFile: string;
  worktreesDir: string;
  snapshotsDir: string;
};

export function resolveAlwaysOnPaths(input: {
  politHome: string;
  projectKey: string;
  worktreesBaseDir?: string;
  snapshotsBaseDir?: string;
}): AlwaysOnPaths {
  const politHome = resolve(input.politHome);
  const projectKey = resolve(input.projectKey);
  const projectId = createProjectId(projectKey);
  const rootDir = resolve(politHome, ROOT_DIR_NAME);
  const projectDir = resolve(rootDir, "projects", projectId);
  const worktreesDir = resolve(input.worktreesBaseDir ?? resolve(rootDir, "worktrees"), projectId);
  const snapshotsDir = resolve(input.snapshotsBaseDir ?? resolve(rootDir, "snapshots"), projectId);

  return {
    politHome,
    projectKey,
    projectId,
    rootDir,
    projectDir,
    stateFile: resolve(projectDir, "state.json"),
    plansDir: resolve(projectDir, "plans"),
    planIndexFile: resolve(projectDir, "plans", "index.json"),
    reportsDir: resolve(projectDir, "reports"),
    runsDir: resolve(projectDir, "runs"),
    runHistoryFile: resolve(projectDir, "run-history.jsonl"),
    locksDir: resolve(projectDir, "locks"),
    discoveryLockFile: resolve(projectDir, "locks", "discovery.lock"),
    worktreesDir,
    snapshotsDir,
  };
}

export function planMarkdownPath(paths: AlwaysOnPaths, planId: string): string {
  return resolve(paths.plansDir, `${sanitizeId(planId)}.md`);
}

export function reportMarkdownPath(paths: AlwaysOnPaths, runId: string): string {
  return resolve(paths.reportsDir, `${sanitizeId(runId)}.md`);
}

export function runEventsPath(paths: AlwaysOnPaths, runId: string): string {
  return resolve(paths.runsDir, `${sanitizeId(runId)}.events.jsonl`);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}
