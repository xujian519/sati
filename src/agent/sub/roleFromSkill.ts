/**
 * 角色装配 — SKILL.md 角色 → SubagentDefinition。
 *
 * 角色 SKILL.md frontmatter：
 *   ---
 *   name: 撰写专家
 *   description: 专利撰写角色
 *   type: role
 *   tools: ["*"]
 *   domains: ["drafting", "quality", "patent", "filesystem", "session"]
 *   omitTools: ["web_search"]
 *   readOnly: false
 *   systemPrompt: 你是专利撰写专家……
 *   ---
 *
 * 由 SkillManager 解析出 SkillSummary.role 后，经 roleFromSkill 转换为
 * SubagentDefinition，再 registerRoleDefinition 注册进子代理注册表。
 */

import type { PluginSkillContribution } from "../../extension/plugins/runtime/PluginRuntime.js";
import type { SkillSummary } from "../../extension/skills/types.js";
import type { SubagentDefinition } from "./builtinSubagentTypes.js";

/** 把角色 skill 转换为子代理定义；非角色 skill 返回 null。 */
export function roleFromSkill(skill: SkillSummary): SubagentDefinition | null {
  const role = skill.role;
  if (!role) return null;
  return {
    id: skill.slug,
    description: skill.description,
    allowedTools: role.tools ?? ["*"],
    visibleDomains: role.domains,
    hiddenDomains: undefined,
    omitTools: role.omitTools,
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: role.readOnly ?? false,
    systemPromptSuffix: role.systemPrompt ?? "",
  };
}

/** 从插件贡献（PluginSkillContribution.role）转换为子代理定义；非角色返回 null。 */
export function roleFromContribution(skill: PluginSkillContribution): SubagentDefinition | null {
  const role = skill.role;
  if (!role) return null;
  // 角色 id 来自 frontmatter name（不可信输入）：按 skill slug 规则校验，
  // 非法字符不进子代理 id（事件/日志/提示词字段）。
  if (!SLUG_RE.test(skill.name)) return null;
  return {
    id: skill.name,
    description: skill.description ?? skill.name,
    allowedTools: role.tools ?? ["*"],
    visibleDomains: role.domains,
    hiddenDomains: undefined,
    omitTools: role.omitTools,
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: role.readOnly ?? false,
    systemPromptSuffix: role.systemPrompt ?? "",
  };
}

/** 与 SkillManager 的 slug 规则保持一致（安全目录名/标识符）。 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/** 从 skills 列表中收集全部角色定义（内部名去重，slug 即角色 id）。 */
export function rolesFromSkills(skills: SkillSummary[]): SubagentDefinition[] {
  const seen = new Set<string>();
  const roles: SubagentDefinition[] = [];
  for (const skill of skills) {
    const definition = roleFromSkill(skill);
    if (definition === null || seen.has(definition.id)) continue;
    seen.add(definition.id);
    roles.push(definition);
  }
  return roles;
}
