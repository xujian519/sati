import { homedir } from "node:os";
import { resolve } from "node:path";

export type PolitPathEnv = Record<string, string | undefined>;

export const DEFAULT_POLIT_HOME = "~/.politdeck";
export const POLIT_CONFIG_FILE_NAME = "politdeck.yaml";

export function resolvePolitHome(env: PolitPathEnv = process.env): string {
  return normalizeHomePath(env.POLIT_HOME ?? DEFAULT_POLIT_HOME);
}

export function getPolitConfigFilePath(politHome: string): string {
  return resolve(politHome, POLIT_CONFIG_FILE_NAME);
}

export function getPolitProjectChatDir(projectRoot: string, politHome: string): string {
  return resolve(politHome, "projects", createProjectId(projectRoot), "chats");
}

export function createProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  return normalizedRoot.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
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
