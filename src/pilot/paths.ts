import { homedir } from "node:os";
import { resolve } from "node:path";
import { findCanonicalProjectRoot } from "../session/worktree/findCanonicalProjectRoot.js";

export type PilotPathEnv = Record<string, string | undefined>;

export const DEFAULT_PILOT_HOME = "~/.pilotdeck";
export const PILOT_CONFIG_FILE_NAME = "pilotdeck.yaml";
export const PILOT_PROJECT_DIR_NAME = ".pilotdeck";

export type PilotExtensionPaths = {
  globalPluginsDir: string;
  globalSkillsDir: string;
  projectPluginsDir: string;
  projectSkillsDir: string;
};

export function resolvePilotHome(env: PilotPathEnv = process.env): string {
  return normalizeHomePath(env.PILOT_HOME ?? DEFAULT_PILOT_HOME);
}

export function getPilotConfigFilePath(pilotHome: string): string {
  return resolve(pilotHome, PILOT_CONFIG_FILE_NAME);
}

export function getPilotProjectConfigFilePath(projectRoot: string): string {
  return resolve(projectRoot, PILOT_PROJECT_DIR_NAME, PILOT_CONFIG_FILE_NAME);
}

export function getPilotMemoryRootDir(pilotHome: string): string {
  return resolve(pilotHome, "memory");
}

export function getPilotProjectChatDir(projectRoot: string, pilotHome: string): string {
  return resolve(pilotHome, "projects", createProjectId(projectRoot), "chats");
}

export function getPilotProjectPlanDir(projectRoot: string, pilotHome: string): string {
  return resolve(pilotHome, "projects", createProjectId(projectRoot), "plans");
}

/**
 * Async variant that first resolves a worktree cwd to its canonical
 * main-repository root (so all worktrees share the same project ID).
 * Use this for all new code. The sync `getPilotProjectChatDir` keeps
 * the legacy behaviour for callers that cannot await.
 */
export async function getPilotProjectChatDirAsync(
  projectRoot: string,
  pilotHome: string,
): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return resolve(pilotHome, "projects", createProjectId(canonical), "chats");
}

export function getPilotExtensionPaths(projectRoot: string, pilotHome: string): PilotExtensionPaths {
  return {
    globalPluginsDir: resolve(pilotHome, "plugins"),
    globalSkillsDir: resolve(pilotHome, "skills"),
    projectPluginsDir: resolve(projectRoot, PILOT_PROJECT_DIR_NAME, "plugins"),
    projectSkillsDir: resolve(projectRoot, PILOT_PROJECT_DIR_NAME, "skills"),
  };
}

export function createProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  return normalizedRoot.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

/**
 * Async variant: resolves canonical (worktree-aware) root before hashing.
 * Two worktrees of the same repo produce the same project ID.
 */
export async function createProjectIdAsync(projectRoot: string): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return createProjectId(canonical);
}

function normalizeHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}
