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
import type { SkillRoleConfig, SkillSummary } from "../../extension/skills/types.js";
import type { SubagentDefinition } from "./builtinSubagentTypes.js";

/**
 * 带 domain 的工具要求对应 visibleDomains 域，否则子代理经
 * scopeTools 裁剪后静默不可见。角色声明了这些工具但缺域时启动提示。
 * （law_search → legal；paper_search/paper_list_sources → literature）
 */
const DOMAIN_REQUIRED_TOOLS: Record<string, string> = {
  law_search: "legal",
  paper_search: "literature",
  paper_list_sources: "literature",
  patent_metadata: "patent",
  patent_legal_status: "patent",
  patent_search: "patent",
};

/** 校验角色定义的工具/域一致性，不匹配时输出 warn（不阻断注册）。 */
function warnDomainMismatch(definition: SubagentDefinition): void {
  const domains = definition.visibleDomains;
  // 未声明 domains → scopeTools 不裁剪，工具天然可见，无需提示。
  if (!domains || domains.length === 0) return;
  const domainSet = new Set(domains);
  const tools = definition.allowedTools;
  const wildcard = tools.includes("*");
  for (const [tool, requiredDomain] of Object.entries(DOMAIN_REQUIRED_TOOLS)) {
    if (!wildcard && !tools.includes(tool)) continue;
    if (domainSet.has(requiredDomain)) continue;
    console.warn(
      `[sati] role ${definition.id}: tools 暴露 ${tool} 但 domains 缺 "${requiredDomain}"，` +
        `子代理将看不到该工具（请在 domains 中补充 "${requiredDomain}"）`,
    );
  }
}

/** 把角色 skill 转换为子代理定义；非角色 skill 返回 null。 */
export function roleFromSkill(skill: SkillSummary): SubagentDefinition | null {
  const role = skill.role;
  if (!role) return null;
  const definition: SubagentDefinition = {
    id: skill.slug,
    description: skill.description,
    allowedTools: role.tools ?? ["*"],
    visibleDomains: role.domains,
    hiddenDomains: undefined,
    omitTools: role.omitTools,
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: role.readOnly ?? false,
    systemPromptSuffix: buildRoleSystemPrompt(role),
  };
  warnDomainMismatch(definition);
  return definition;
}

/** 从插件贡献（PluginSkillContribution.role）转换为子代理定义；非角色返回 null。 */
export function roleFromContribution(skill: PluginSkillContribution): SubagentDefinition | null {
  const role = skill.role;
  if (!role) return null;
  // 角色 id 来自 frontmatter name（不可信输入）：按 skill slug 规则校验，
  // 非法字符不进子代理 id（事件/日志/提示词字段）。
  if (!SLUG_RE.test(skill.name)) return null;
  const definition: SubagentDefinition = {
    id: skill.name,
    description: skill.description ?? skill.name,
    allowedTools: role.tools ?? ["*"],
    visibleDomains: role.domains,
    hiddenDomains: undefined,
    omitTools: role.omitTools,
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: role.readOnly ?? false,
    systemPromptSuffix: buildRoleSystemPrompt(role),
  };
  warnDomainMismatch(definition);
  return definition;
}

/**
 * 编译角色系统提示：基础 systemPrompt + 知识接线声明（knowledge）。
 *
 * knowledge 声明把"必查 wiki 卡片 / 需判例检索 / 需法条核验"编译进角色
 * systemPrompt 末尾，使角色 turn 0 即携带知识检索指令（声明式知识预载），
 * 而非依赖模型自觉或撞 query。无 knowledge 声明时原样返回基础提示。
 */
function buildRoleSystemPrompt(role: SkillRoleConfig): string {
  const base = role.systemPrompt ?? "";
  const knowledge = role.knowledge;
  if (!knowledge) return base;
  const parts: string[] = [];
  if (knowledge.cards && knowledge.cards.length > 0) {
    parts.push(`必查 wiki 卡片（经 \`patent_wiki_search\` 检索）：${knowledge.cards.join("、")}`);
  }
  if (knowledge.requireCaseSearch) {
    parts.push("相似在先决定的论证细节用 `patent_case_search` 检索");
  }
  if (knowledge.requireLawSearch) {
    parts.push("法条原文用 `law_search` 核验");
  }
  return parts.length > 0 ? `${base}\n\n【知识接线】${parts.join("；")}。` : base;
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
