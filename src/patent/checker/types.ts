/**
 * src/patent/checker — dual-track 确定性规则检查器（移植自 Mady domains/workflows/patent/rule_engine.go）。
 *
 * 定位：与 LLM 语义判断轨并行的确定性判定轨。对专利分析/撰写产出文本做
 * "要素完整性"检查（如新颖性须单独对比、创造性须三步法、侵权须全面覆盖），
 * 输出 pass / needs_revision / blocked 聚合判级。与宪法规则引擎（src/rule，门禁型
 * block/warn/review）互补：宪法引擎管"输出合规拦截"，本检查器管"专业判断质量判定"。
 */

/** 检查类型：决定规则使用哪组检查参数（RequiredElements/StepElements/...）。 */
export type CheckType =
  | "patent_novelty" // 新颖性（A22.2）：RequiredElements 全匹配 + 可选单独对比
  | "patent_inventiveness" // 创造性（A22.3）：StepElements 三步各至少命中其一
  | "patent_infringement" // 侵权：RequiredElements 全匹配
  | "patent_disclosure" // 充分公开（A26.3）：RequiredAspects 全匹配
  | "patent_claim_analysis" // 权利要求分析：Dimensions 各维度命中任一模式
  | "patent_design_comparison" // 外观设计对比：RequiredElements 全匹配
  | "patent_public_access" // 公开方式认定：RequiredElements 全匹配
  | "patent_amendment_scope" // 修改超范围（A33）：RequiredElements 全匹配
  | "patent_subject_matter"; // 保护客体（A2）：RequiredElements 全匹配

/**
 * 规则级别：决定聚合判级的阈值。
 * - 0 (Must)：失败即 blocked
 * - 1 (Should)：失败即 blocked
 * - 2 (Quality)：3 条及以上失败才 needs_revision
 */
export type RuleLevel = 0 | 1 | 2;

export const LevelMust: RuleLevel = 0;
export const LevelShould: RuleLevel = 1;
export const LevelQuality: RuleLevel = 2;

/** 严重度（报告展示用；判级只看 Level）。 */
export type Severity = "critical" | "major" | "minor";

/** 聚合判级结论。 */
export type Verdict = "pass" | "needs_revision" | "blocked";

/** 单条确定性检查规则（与 Mady CheckRule 同构）。 */
export interface CheckRule {
  id: string;
  name: string;
  description: string;
  level: RuleLevel;
  severity: Severity;
  /** 失败时面向用户的提示信息。 */
  message: string;
  checkType: CheckType;
  /** 适用域过滤（"" = 所有域；域不匹配的规则在 Evaluate 时跳过）。 */
  domain: string;
  /** CheckNovelty/Infringement/Design/PublicAccess/Amendment/SubjectMatter：全部须命中。 */
  requiredElements?: string[];
  /** CheckInventiveness：三步法，每步至少命中其一。 */
  stepElements?: string[][];
  /** CheckDisclosure：全部须命中。 */
  requiredAspects?: string[];
  /** CheckClaimAnalysis：维度名列表（见 claimDimensionPatterns）。 */
  dimensions?: string[];
  /** 推理路径步骤完整性：每步至少命中其一（任意 CheckType 后置校验）。 */
  pathElements?: string[][];
  /** CheckNovelty：强制单独对比原则（命中禁止短语即失败）。 */
  singleComparison?: boolean;
  fixSuggestion: string;
}

/** 单条规则评估结果（仅失败规则产出；passed 恒为 false）。 */
export interface RuleCheckResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  level: RuleLevel;
  severity: Severity;
  message: string;
  fixSuggestion: string;
}

/** 规则引擎评估上下文：给定规则集 + 文本 + 域过滤。 */
export interface RuleEngineOptions {
  /** 规则集（缺省使用注册的全部规则）。 */
  rules?: CheckRule[];
  /** 域过滤（缺省或 "" = 全部；可传多个域，规则 domain 匹配任一即评估）。 */
  domain?: string | readonly string[];
}
