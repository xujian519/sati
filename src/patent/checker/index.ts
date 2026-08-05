/**
 * src/patent/checker — dual-track 确定性规则检查器。
 *
 * 使用示例：
 * ```ts
 * import { RuleEngine, aggregate, defaultPatentRules } from "./checker/index.js";
 * const engine = new RuleEngine();
 * engine.registerMany(defaultPatentRules());
 * const failures = engine.evaluate(text, { domain: "patent_novelty" });
 * const verdict = aggregate(failures); // "pass" | "needs_revision" | "blocked"
 * ```
 */

export type {
  CheckRule,
  CheckType,
  RuleCheckResult,
  RuleEngineOptions,
  RuleLevel,
  Severity,
  Verdict,
} from "./types.js";
export { LevelMust, LevelQuality, LevelShould } from "./types.js";

export {
  RuleEngine,
  aggregate,
  formatRuleResults,
  matchKeyword,
  matchKeywordsAll,
  matchKeywordsAny,
} from "./engine.js";

export {
  TERM_CLOSEST_PRIOR_ART,
  TERM_CLOSEST_PRIOR_ART_FULL,
  TERM_COMBINATION_HINT,
  TERM_COMBINATION_MOTIVATION,
  TERM_DESIGN_PATENT,
  TERM_DIFF_FEATURES,
  TERM_DISTINGUISHING_FEATURES,
  TERM_ENABLE,
  TERM_FILING_DATE,
  TERM_INVENTIVENESS,
  TERM_NOVELTY,
  TERM_PRIORITY,
  TERM_PRIORITY_DATE,
  TERM_PRIOR_ART_DOC,
  TERM_SCI_DISCOVERY,
  TERM_SUFFICIENT_DISCLOSURE,
  TERM_TECH_FEATURE,
  TERM_TECH_HINT,
  DOMAIN_AMENDMENT,
  DOMAIN_CLAIMS,
  DOMAIN_DESIGN,
  DOMAIN_DISCLOSURE,
  DOMAIN_EXAMINATION,
  DOMAIN_INFRINGEMENT,
  DOMAIN_INVALIDATION,
  DOMAIN_INVENTIVENESS,
  DOMAIN_NOVELTY,
  DOMAIN_REEXAMINATION,
  DOMAIN_SPEC,
  SPEC_COMMERCIAL_BAN_PHRASES,
  SPEC_SCOPE_BAN_PHRASES,
  SPEC_SECTION_TERMS,
  DIM_CONSISTENCY,
  DIM_CLARITY,
  DIM_ESSENTIAL,
  DIM_SUPPORT,
} from "./constants.js";

export {
  defaultPatentRules,
  designRules,
  disclosureRules,
  infringementRules,
  inventivenessRules,
  invalidationRules,
  noveltyRules,
  priorityRules,
  publicAccessRules,
  reasoningPatternRules,
  reexaminationRules,
  specRules,
  subjectMatterRules,
} from "./rules.js";
