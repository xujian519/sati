// llm-extraction 的项目 hint/信号启发式（从 llm-extraction.ts 拆出，G7 聚类，逐字搬移）。
// 纯函数：全部为正则/信号判定与候选合成，无 IO。正则链顺序决定输出（首中即返）。
import { truncateForPrompt, normalizeWhitespace, truncate, uniqueStrings } from "./llm-normalizers.js";
import type { MemoryCandidate, MemoryMessage, ProjectIdentityHint } from "../types.js";

const STABLE_FORMAL_PROJECT_ID_PATTERN = /^project_[a-z0-9]+$/;

function stripExplicitRememberLead(text: string): string {
  return normalizeWhitespace(text);
}

function splitProfileFacts(text: string): string[] {
  return uniqueStrings(
    text
      .replace(/\r/g, "\n")
      .split(/\n|[，,；;。.!?]/)
      .map(line => normalizeWhitespace(line))
      .filter(line => line.length >= 2),
    20,
  );
}

function stripMarkdownSyntax(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/\r/g, "\n")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/^\s*[-*+]\s*/gm, "")
      .replace(/`+/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1"),
  );
}

function isStableFormalProjectId(value: string | undefined): boolean {
  return STABLE_FORMAL_PROJECT_ID_PATTERN.test((value ?? "").trim());
}

function looksLikeCollaborationRuleText(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  return (
    /(以后回答|回答时|回复时|同步进展|代码示例|先给结论|先说完成了什么|不要写成|怎么和我协作|怎么交付|怎么汇报|请你|交付时|汇报|review|评审|写法|输出格式|回复格式|格式化输出)/i.test(
      normalized,
    ) ||
    /((给我|你|请按|每次).{0,12}(交付|输出|回复|汇报).{0,20}(标题|正文|封面文案))|((先给|再给).{0,12}(标题|正文|封面文案))/i.test(
      normalized,
    )
  );
}

function deriveFeedbackCandidateName(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (/(交付|标题|正文|封面文案)/i.test(normalized)) return "delivery-rule";
  if (/(汇报|同步进展|风险|完成了什么)/i.test(normalized)) return "reporting-rule";
  if (/(格式|风格|写法|回复时|回答时)/i.test(normalized)) return "format-rule";
  return "collaboration-rule";
}

function looksLikeConcreteProjectMemoryText(text: string): boolean {
  return /(目标是|当前卡点|里程碑|要出可演示版本|要给团队试用|阶段|进展|deadline|blocker|next step|版本|试用|发布|第一版|只做|先做|不碰|约束|限制|一期范围|当前范围|保留|新增一级|memory tab|当前风险|跨会话召回|project\.meta|当前 project)/i.test(
    normalizeWhitespace(text),
  );
}

function looksLikeProjectRiskText(text: string): boolean {
  return /(当前风险|风险是|主要风险|核心风险|跨会话召回|project\.meta|当前 project|召回[^。；;\n]*project|召回[^。；;\n]*当前项目)/i.test(
    normalizeWhitespace(text),
  );
}

function looksLikeProjectScopeText(text: string): boolean {
  return /(一期范围|当前范围|本期范围|替换旧记忆|保留[^。；;\n]*(?:memory_overview|memory_list|memory_search|memory_get|memory_flush|memory_dream)|新增一级[^。；;\n]*memory tab|新增[^。；;\n]*memory tab|memory_overview|memory_list|memory_search|memory_get|memory_flush|memory_dream)/i.test(
    normalizeWhitespace(text),
  );
}

function looksLikeProjectFollowUpText(text: string): boolean {
  const normalized = normalizeWhitespace(stripExplicitRememberLead(text));
  if (!normalized) return false;
  return /(接下来|下一步|下个阶段|最该补|还差|先做|先把|优先|先补|最优先|当前卡点|卡点|阻塞|受众|定位|内容角度|角度|约束|限制|不要碰|别碰|统一成|模板化|目标人群|适合打给|更适合打给|核心约束|镜头顺序|标题锚点|开头三秒)/i.test(
    normalized,
  );
}

function looksLikeProjectNextStepText(text: string): boolean {
  return /(接下来|下一步|最该补|还差|先做|先把|优先|先补|最优先)/i.test(normalizeWhitespace(text));
}

function looksLikeProjectConstraintText(text: string): boolean {
  return /(约束|限制|不要|别碰|统一成|模板化|必须|只能|先别|不碰)/i.test(normalizeWhitespace(text));
}

function looksLikeProjectBlockerText(text: string): boolean {
  return /(卡点|阻塞|难点|问题在于|麻烦是|还差)/i.test(normalizeWhitespace(text));
}

function extractUniqueBatchProjectName(messages: MemoryMessage[]): string {
  const names = new Map<string, string>();
  for (const message of messages.filter(entry => entry.role === "user")) {
    const value = extractProjectNameHint(message.content);
    if (!value) continue;
    const key = value.toLowerCase();
    if (!names.has(key)) names.set(key, value);
  }
  return names.size === 1 ? (Array.from(names.values())[0] ?? "") : "";
}

function extractProjectDescriptorHint(text: string): string {
  const patterns = [
    /(?:它|这个项目|该项目|项目)\s*是(?:一个)?\s*([^。；;\n，,]+)/i,
    /(?:这是|这会是)(?:一个)?\s*([^。；;\n，,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncateForPrompt(value, 220);
  }
  return "";
}

function extractProjectStageHint(text: string): string {
  const normalized = normalizeWhitespace(stripExplicitRememberLead(text));
  if (!normalized) return "";
  const patterns = [
    /((?:目前|现在|当前)[^。；;\n，,]*?(?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:还在|正在|处于)[^。；;\n，,]*?(?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:目前|现在|当前|还在|正在|处于)[^。；;\n，,]*?(?:验证阶段|摸索阶段|试水阶段))/i,
    /((?:[^。；;\n，,]{0,24})(?:验证阶段|摸索阶段|试水阶段))/i,
    /((?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:验证阶段|摸索阶段|试水阶段))/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1] ? truncateForPrompt(normalizeWhitespace(match[1]), 220) : "";
    if (value) return value;
  }
  return "";
}

function extractProjectNameHint(text: string): string {
  const patterns = [
    /(?:先叫它|先叫|叫它|叫做|项目名(?:字)?(?:先)?叫(?:做)?)\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
    /项目[，, ]*(?:先)?叫(?:做)?\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncate(value, 80);
  }
  return "";
}

function hasGenericProjectAnchor(text: string): boolean {
  return /(?:这个项目|该项目|本项目|这个东西|这件事)/i.test(normalizeWhitespace(text));
}

function projectIdentityTerms(project: ProjectIdentityHint): string[] {
  return uniqueStrings(
    [project.projectName]
      .map(item => normalizeWhitespace(item).toLowerCase())
      .filter(item => item.length > 0 && item.length <= 80 && !/[。！？!?]/.test(item)),
    20,
  );
}

function selectKnownProjectHint(text: string, knownProjects: ProjectIdentityHint[]): ProjectIdentityHint | undefined {
  if (knownProjects.length === 0) return undefined;
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return undefined;
  const exactMatches = knownProjects.filter(project =>
    projectIdentityTerms(project).some(term => term && normalized.includes(term)),
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  const projectFollowUpSignal =
    hasGenericProjectAnchor(text) ||
    looksLikeProjectFollowUpText(text) ||
    looksLikeConcreteProjectMemoryText(text) ||
    looksLikeProjectRiskText(text) ||
    looksLikeProjectScopeText(text);
  if (knownProjects.length === 1 && projectFollowUpSignal) {
    return knownProjects[0];
  }
  return undefined;
}

function isGenericProjectCandidateName(name: string): boolean {
  const normalized = normalizeWhitespace(name).toLowerCase();
  return normalized === "" || ["overview", "project", "project-item", "memory-item"].includes(normalized);
}

function isLikelyHumanReadableProjectIdentifier(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  if (isStableFormalProjectId(normalized)) return false;
  if (isGenericProjectCandidateName(normalized)) return false;
  return normalized.length >= 2 && normalized.length <= 80;
}

function extractProjectNameFromContent(content: string): string {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return "";
  const patterns = [
    /(?:项目名称|项目名|名称)\s*[:：]\s*([^\n。；;，,（）()]{2,80})/i,
    /(?:项目是|项目叫|先叫)\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncate(value, 80);
  }
  return "";
}

function sanitizeProjectDescriptionText(text: string, projectName: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return "";
  let next = normalized.replace(/^(?:项目名称|项目名|名称)\s*[:：]\s*/i, "").replace(/^(?:项目叫|项目是|先叫)\s*/i, "");
  if (projectName) {
    const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next
      .replace(new RegExp(`^${escaped}\\s*[（(][^)）]+[)）]?[:：]?\\s*`), "")
      .replace(new RegExp(`^${escaped}[:：]?\\s*`), "");
  }
  next = next.replace(/^[：:，,。；;\s]+/, "");
  return truncateForPrompt(normalizeWhitespace(next), 180);
}

function extractTimelineHints(text: string): string[] {
  const lines = text
    .replace(/\r/g, "\n")
    .split(/\n|(?<=[。！？!?])/)
    .map(line => normalizeWhitespace(line))
    .filter(Boolean);
  return Array.from(new Set(lines.filter(line => /\b20\d{2}-\d{2}-\d{2}\b/.test(line)))).slice(0, 10);
}

function extractSingleHint(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  return match?.[1] ? truncateForPrompt(match[1], 220) : "";
}

function sanitizeFeedbackSectionText(value: string | undefined): string {
  const normalized = normalizeWhitespace(value ?? "");
  if (!normalized) return "";
  if (
    [
      /explicit project collaboration preference captured from the user/i,
      /project anchor is not formalized yet/i,
      /project-local collaboration instruction without a formal project id yet/i,
      /project-local collaboration instruction for the current project/i,
      /project-local collaboration rule rather than a standalone project memory/i,
      /follow this collaboration rule in future project replies unless the user overrides it/i,
      /apply this rule only after dream attaches it to a formal project context/i,
      /keep it in temporary project memory until dream can attach it to the right project/i,
      /apply this rule in the current project context/i,
      /keep this as current-project feedback memory/i,
    ].some(pattern => pattern.test(normalized))
  ) {
    return "";
  }
  return normalized;
}

function buildSyntheticProjectFollowUpCandidate(input: {
  focusText: string;
  timestamp: string;
  sessionKey?: string;
  uniqueBatchProjectName: string;
  explicitProjectName: string;
  explicitProjectDescriptor: string;
  explicitProjectStage: string;
  explicitTimeline: string[];
  explicitGoal: string;
  explicitBlocker: string;
}): MemoryCandidate | null {
  const normalizedFocus = truncateForPrompt(normalizeWhitespace(stripExplicitRememberLead(input.focusText)), 220);
  if (!normalizedFocus) return null;
  const projectName = truncateForPrompt(input.explicitProjectName || input.uniqueBatchProjectName, 80);
  if (!projectName || isGenericProjectCandidateName(projectName)) return null;
  const description = truncateForPrompt(
    input.explicitProjectDescriptor || input.explicitGoal || input.explicitProjectStage || normalizedFocus,
    180,
  );
  const projectScopeSignal = looksLikeProjectScopeText(normalizedFocus);
  const projectRiskSignal = looksLikeProjectRiskText(normalizedFocus);
  return {
    type: "project",
    scope: "project",
    name: projectName,
    description,
    ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
    capturedAt: input.timestamp,
    ...(input.explicitProjectStage ? { stage: input.explicitProjectStage } : {}),
    ...(projectScopeSignal ? { decisions: [normalizedFocus] } : {}),
    ...(looksLikeProjectConstraintText(normalizedFocus) ? { constraints: [normalizedFocus] } : {}),
    ...(looksLikeProjectNextStepText(normalizedFocus) ? { nextSteps: [normalizedFocus] } : {}),
    ...(input.explicitBlocker || looksLikeProjectBlockerText(normalizedFocus) || projectRiskSignal
      ? { blockers: uniqueStrings([input.explicitBlocker, normalizedFocus].filter(Boolean), 4) }
      : {}),
    ...(input.explicitTimeline.length > 0 ? { timeline: input.explicitTimeline } : {}),
    notes: projectScopeSignal || projectRiskSignal ? [] : [normalizedFocus],
  };
}

export {
  buildSyntheticProjectFollowUpCandidate,
  deriveFeedbackCandidateName,
  extractProjectDescriptorHint,
  extractProjectNameFromContent,
  extractProjectNameHint,
  extractProjectStageHint,
  extractSingleHint,
  extractTimelineHints,
  extractUniqueBatchProjectName,
  hasGenericProjectAnchor,
  isGenericProjectCandidateName,
  isLikelyHumanReadableProjectIdentifier,
  isStableFormalProjectId,
  looksLikeCollaborationRuleText,
  looksLikeConcreteProjectMemoryText,
  looksLikeProjectBlockerText,
  looksLikeProjectConstraintText,
  looksLikeProjectFollowUpText,
  looksLikeProjectNextStepText,
  looksLikeProjectRiskText,
  looksLikeProjectScopeText,
  projectIdentityTerms,
  sanitizeFeedbackSectionText,
  sanitizeProjectDescriptionText,
  selectKnownProjectHint,
  splitProfileFacts,
  stripExplicitRememberLead,
  stripMarkdownSyntax,
};
