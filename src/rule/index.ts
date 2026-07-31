/**
 * 宪法规则引擎 — 模块入口（protocol/ + runtime/ 两层）。
 *
 * 用法：
 *   const { ruleSet } = parseRuleSetFromYaml(yamlText);
 *   const evaluation = evaluateText(text, ruleSet);
 */
export type {
  CitationAnalysisCheck,
  ConstitutionalRule,
  KeywordBlocklistCheck,
  LoadedRuleSet,
  PatternAnalysisCheck,
  RuleAction,
  RuleCheck,
  RuleCheckType,
  RuleEvaluation,
  RuleSet,
  RuleSetValidationIssue,
  RuleSeverity,
  RuleViolation,
  StructuralAnalysisCheck,
  StructuralElement,
} from "./protocol/types.js";

export {
  evaluateRule,
  evaluateText,
  groupByAction,
} from "./runtime/RuleEngine.js";
export {
  loadRuleSetDir,
  loadRuleSetFromFile,
  mergeRuleSets,
  parseRuleSetFromYaml,
  validateRuleSet,
} from "./runtime/RuleLoader.js";
export {
  RuleOutputGate,
  type RuleOutputGateOptions,
  type RuleOutputGateResult,
} from "./runtime/output-gate.js";
export {
  loadPatentComplianceRuleSet,
  type PatentComplianceLoadResult,
} from "./runtime/patent-compliance.js";
export {
  rulesToPolicyDenyRules,
  type RulesToPolicyOptions,
  type RulesToPolicyResult,
} from "./runtime/policy-bridge.js";
