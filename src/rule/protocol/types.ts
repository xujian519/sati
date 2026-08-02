/**
 * 宪法规则引擎 — 协议层（类型契约）。
 *
 * 引入自 BCIP codex-patent-constitutional 的设计：以声明式规则（YAML）描述
 * "AI 在生成/执行时必须遵守的约束"，由引擎逐条对文本做确定性检查。
 *
 * 规则生命周期：资产 YAML（rules/**）→ RuleLoader 加载校验 → RuleEngine 评估
 * → 按 action 分发到输出门禁（review/warn）或工具拦截（block）。
 */

export type RuleSeverity = "critical" | "major" | "minor";

/**
 * 规则动作语义：
 *   - block  ：强制拦截（工具调用前拒绝；输出门禁中视为最高级违规）
 *   - review ：挂起人工审批（输出门禁 → DeferredPersist 语义）
 *   - warn   ：仅追加提示，不阻断
 *   - log    ：仅记录，不改变行为
 */
export type RuleAction = "block" | "warn" | "review" | "log";

/** 检查类型标识（对齐 BCIP RuleCheck 的 tagged enum 设计）。 */
export type RuleCheckType =
  | "keyword_blocklist"
  | "pattern_analysis"
  | "structural_analysis"
  | "citation_analysis"
  | "synonym_match";

/**
 * keyword_blocklist — 关键词黑名单。
 * 每个条目为一组用 `|` 分隔的关键词（OR 语义），文本命中任意一组即违规。
 * 示例：["赌博|博彩|赌场", "克隆人|人类胚胎"]
 */
export type KeywordBlocklistCheck = {
  type: "keyword_blocklist";
  keywords: string[];
  /** 否定语境过滤：命中位置前出现 "防止/避免/不用于/排除" 等否定词时放行（"防止赌博"不排除）。 */
  negationContext?: boolean;
  /** 命中时覆盖的严重级别（缺省用规则级 severity）。 */
  severityIfFound?: RuleSeverity;
};

/** pattern_analysis — 正则模式分析（case-insensitive）。 */
export type PatternAnalysisCheck = {
  type: "pattern_analysis";
  patterns: string[];
  /** 最少命中次数（缺省 1）。 */
  minMatches?: number;
};

/** structural_analysis — 结构要素分析：requiresAll 中每个要素须命中其 patterns 之一。 */
export type StructuralElement = {
  /** 要素名，如 "technical_means" / "technical_problem" / "technical_effect"。 */
  element: string;
  description?: string;
  patterns: string[];
};

export type StructuralAnalysisCheck = {
  type: "structural_analysis";
  requiresAll: StructuralElement[];
  /** 最低置信度 0-1 = 命中要素数 / 总要素数；低于则违规（对齐 BCIP min_confidence）。 */
  minConfidence?: number;
};

/**
 * citation_analysis — 法条引用核验。
 * R1 存在性：引用条号不得超过 statute.max。
 */
export type CitationAnalysisCheck = {
  type: "citation_analysis";
  /** 法条名 → 上限与可选主题词表（R2 主题相关性由消费方扩展）。 */
  statutes: Record<string, { max: number; topics?: Record<number, string[]> }>;
};

/**
 * synonym_match — 同义词展开要素分析（移植自 Mady CheckRule 的 RequiredElements）。
 * requirements 中每个要素的 keywords 任一命中（关键词本身 OR 其同义词，否定语境豁免）
 * 即视为满足；与 structural_analysis 的差异在于是同义词语义匹配而非正则。
 * 同义词表资产：rules/patent/synonyms.yaml（由消费方注入 SynonymMap）。
 */
export type SynonymMatchCheck = {
  type: "synonym_match";
  requirements: SynonymRequirement[];
  /** 最低置信度 0-1 = 命中要素数 / 总要素数；低于则违规。 */
  minConfidence?: number;
};

/** synonym_match 的单条要素（element + keywords；keywords 中任一命中即满足）。 */
export type SynonymRequirement = {
  element: string;
  description?: string;
  keywords: string[];
};

export type RuleCheck =
  | KeywordBlocklistCheck
  | PatternAnalysisCheck
  | StructuralAnalysisCheck
  | CitationAnalysisCheck
  | SynonymMatchCheck;

/** 单条宪法规则（对齐 BCIP ConstitutionalRule）。 */
export type ConstitutionalRule = {
  /** 唯一规则编号，如 "CON-101"。 */
  id: string;
  name: string;
  description?: string;
  /** 适用领域（patent / general 等），用于按域过滤规则。 */
  domain?: string;
  /** 生命周期阶段（自由文本，如 "申请前" / "撰写"）。 */
  phase?: string;
  severity: RuleSeverity;
  action: RuleAction;
  /** 法律/规范依据原文。 */
  legalBasis?: string;
  check: RuleCheck;
};

/** 规则集（一个 YAML 文件 = 一个 RuleSet）。 */
export type RuleSet = {
  version?: string;
  rules: ConstitutionalRule[];
};

/** 单条违规记录。 */
export type RuleViolation = {
  ruleId: string;
  ruleName: string;
  severity: RuleSeverity;
  action: RuleAction;
  /** 法律/规范依据原文（透传自规则）。 */
  legalBasis?: string;
  /** 面向用户/模型的说明（中文）。 */
  message: string;
  /** 命中的原文证据片段。 */
  evidence: string[];
};

/** 一次评估的结果。 */
export type RuleEvaluation = {
  violations: RuleViolation[];
};

/** 规则集校验问题（加载期诊断）。 */
export type RuleSetValidationIssue = {
  source?: string;
  ruleId?: string;
  message: string;
};

/** 加载器结果：规则集 + 跳过文件警告。 */
export type LoadedRuleSet = {
  ruleSet: RuleSet;
  source: string;
  warnings: RuleSetValidationIssue[];
};
