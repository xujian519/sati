import type { SettingsProject } from "../types";
import { asRecord } from "../../../../utils/unknown";

type SatiConfigLike = Record<string, unknown>;

export function getAlwaysOnProjectRoot(project: SettingsProject): string {
  const root = project.fullPath || project.path || "";
  return typeof root === "string" ? root.trim().replace(/[\\/]+$/, "") : "";
}

export function isAlwaysOnProjectEnabled(config: SatiConfigLike, project: SettingsProject): boolean {
  const root = getAlwaysOnProjectRoot(project);
  if (!root) return false;
  const alwaysOn: Record<string, unknown> = asRecord(config.alwaysOn) ?? {};
  const projects: Record<string, unknown> = asRecord(alwaysOn.projects) ?? {};
  return asRecord(projects[root])?.enabled === true;
}

export function setAlwaysOnProjectEnabled<T extends SatiConfigLike>(
  config: T,
  project: SettingsProject,
  enabled: boolean,
): T {
  const root = getAlwaysOnProjectRoot(project);
  if (!root) return config;

  const alwaysOn: Record<string, unknown> = asRecord(config.alwaysOn) ?? {};
  const projects: Record<string, unknown> = asRecord(alwaysOn.projects) ?? {};

  return {
    ...config,
    alwaysOn: {
      ...alwaysOn,
      projects: {
        ...projects,
        [root]: {
          ...(asRecord(projects[root]) ?? {}),
          enabled,
        },
      },
    },
  };
}
