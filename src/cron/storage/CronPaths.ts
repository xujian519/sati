import { resolve } from "node:path";
import { createProjectId } from "../../polit/paths.js";

const ROOT_DIR_NAME = "cron";

export type CronPaths = {
  politHome: string;
  projectKey: string;
  projectId: string;
  rootDir: string;
  projectDir: string;
  tasksFile: string;
  runsDir: string;
  runHistoryFile: string;
};

export function resolveCronPaths(input: { politHome: string; projectKey: string }): CronPaths {
  const politHome = resolve(input.politHome);
  const projectKey = resolve(input.projectKey);
  const projectId = createProjectId(projectKey);
  const rootDir = resolve(politHome, ROOT_DIR_NAME);
  const projectDir = resolve(rootDir, "projects", projectId);

  return {
    politHome,
    projectKey,
    projectId,
    rootDir,
    projectDir,
    tasksFile: resolve(projectDir, "tasks.json"),
    runsDir: resolve(projectDir, "runs"),
    runHistoryFile: resolve(projectDir, "run-history.jsonl"),
  };
}

export function cronRunEventsPath(paths: CronPaths, runId: string): string {
  return resolve(paths.runsDir, `${sanitizeId(runId)}.events.jsonl`);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}
