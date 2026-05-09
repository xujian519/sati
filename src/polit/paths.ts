import { homedir } from "node:os";
import { resolve } from "node:path";
import { findCanonicalProjectRoot } from "../session/worktree/findCanonicalProjectRoot.js";

export type PolitPathEnv = Record<string, string | undefined>;

export const DEFAULT_POLIT_HOME = "~/.politdeck";
export const POLIT_CONFIG_FILE_NAME = "politdeck.yaml";
export const POLIT_PROJECT_DIR_NAME = ".politdeck";

export type PolitExtensionPaths = {
  globalPluginsDir: string;
  globalSkillsDir: string;
  projectPluginsDir: string;
  projectSkillsDir: string;
};

export function resolvePolitHome(env: PolitPathEnv = process.env): string {
  return normalizeHomePath(env.POLIT_HOME ?? DEFAULT_POLIT_HOME);
}

export function getPolitConfigFilePath(politHome: string): string {
  return resolve(politHome, POLIT_CONFIG_FILE_NAME);
}

export function getPolitProjectConfigFilePath(projectRoot: string): string {
  return resolve(projectRoot, POLIT_PROJECT_DIR_NAME, POLIT_CONFIG_FILE_NAME);
}

export function getPolitProjectChatDir(projectRoot: string, politHome: string): string {
  return resolve(politHome, "projects", createProjectId(projectRoot), "chats");
}

/**
 * Async variant that first resolves a worktree cwd to its canonical
 * main-repository root (so all worktrees share the same project ID).
 * Use this for all new code. The sync `getPolitProjectChatDir` keeps
 * the legacy behaviour for callers that cannot await.
 */
export async function getPolitProjectChatDirAsync(
  projectRoot: string,
  politHome: string,
): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return resolve(politHome, "projects", createProjectId(canonical), "chats");
}

export function getPolitExtensionPaths(projectRoot: string, politHome: string): PolitExtensionPaths {
  return {
    globalPluginsDir: resolve(politHome, "plugins"),
    globalSkillsDir: resolve(politHome, "skills"),
    projectPluginsDir: resolve(projectRoot, POLIT_PROJECT_DIR_NAME, "plugins"),
    projectSkillsDir: resolve(projectRoot, POLIT_PROJECT_DIR_NAME, "skills"),
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
