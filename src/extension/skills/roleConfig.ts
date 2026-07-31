/**
 * SKILL.md frontmatter 角色配置解析（共享给 SkillManager 与插件贡献链路）。
 */

import type { SkillRoleConfig } from "./types.js";

/** 解析角色字段（type: "role" 时调用）；非法字段容错忽略。 */
export function parseRoleConfig(fm: Record<string, unknown>): SkillRoleConfig {
  const asStringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

  return {
    ...(asStringArray(fm.tools) !== undefined ? { tools: asStringArray(fm.tools) } : {}),
    ...(asStringArray(fm.domains) !== undefined ? { domains: asStringArray(fm.domains) } : {}),
    ...(asStringArray(fm.omitTools) !== undefined ? { omitTools: asStringArray(fm.omitTools) } : {}),
    ...(typeof fm.readOnly === "boolean" ? { readOnly: fm.readOnly } : {}),
    ...(typeof fm.systemPrompt === "string" ? { systemPrompt: fm.systemPrompt } : {}),
  };
}

/** 判断 frontmatter 是否为角色声明。 */
export function isRoleFrontmatter(fm: Record<string, unknown>): boolean {
  return fm.type === "role";
}
