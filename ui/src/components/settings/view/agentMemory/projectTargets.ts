/**
 * 项目选择目标（agentMemory 面板共用）。
 *
 * MemoryDataSection 与 KnowledgeCapabilitiesSection 都按"项目 → 目标"选择
 * 查询范围；此处集中路径提取、显示名回退与 `project:` 前缀编解码，
 * 避免两个组件各自实现一套。
 */

import type { SettingsProject } from "../../shared/types";

export type ProjectTarget = {
  value: string;
  label: string;
  path: string;
};

export function projectPath(project: SettingsProject): string {
  return (project.fullPath || project.path || "").trim();
}

export function projectLabel(project: SettingsProject, fallback: string): string {
  const direct = (project.displayName || project.name || "").trim();
  if (direct) return direct;

  const root = projectPath(project);
  const tail = root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return tail || fallback;
}

export function projectTargetValue(projectPath: string): string {
  return `project:${projectPath}`;
}

export function projectPathFromTarget(target: string): string {
  return target.startsWith("project:") ? target.slice("project:".length) : "";
}

/** 按 SettingsProject 顺序构建去重后的项目目标列表（path 相同者只保留首个）。 */
export function buildProjectTargets(projects: SettingsProject[], fallback: string): ProjectTarget[] {
  const seen = new Set<string>();
  return projects.reduce<ProjectTarget[]>((items, project) => {
    const path = projectPath(project);
    if (!path || seen.has(path)) return items;
    seen.add(path);
    items.push({
      value: projectTargetValue(path),
      label: projectLabel(project, fallback),
      path,
    });
    return items;
  }, []);
}
