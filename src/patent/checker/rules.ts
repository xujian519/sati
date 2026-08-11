/**
 * src/patent/checker — 规则集聚合层。
 *
 * core-rules.ts（11 组场景规则，47 条）+ reasoning-rules.ts（24 条推理模式规则），
 * 此处提供 defaultPatentRules() 聚合与全部规则函数的统一 re-export。
 */

import type { CheckRule } from "./types.js";
import {
  designRules,
  disclosureRules,
  infringementRules,
  inventivenessRules,
  invalidationRules,
  noveltyRules,
  priorityRules,
  publicAccessRules,
  reexaminationRules,
  specRules,
  subjectMatterRules,
} from "./core-rules.js";
import { reasoningPatternRules } from "./reasoning-rules.js";

/** 全部默认规则（聚合 11 组场景规则 + 24 条推理模式规则）。 */
export function defaultPatentRules(): CheckRule[] {
  return [
    ...noveltyRules(),
    ...inventivenessRules(),
    ...disclosureRules(),
    ...specRules(),
    ...infringementRules(),
    ...invalidationRules(),
    ...reexaminationRules(),
    ...designRules(),
    ...priorityRules(),
    ...publicAccessRules(),
    ...subjectMatterRules(),
    ...reasoningPatternRules(),
  ];
}

export {
  designRules,
  disclosureRules,
  infringementRules,
  inventivenessRules,
  invalidationRules,
  noveltyRules,
  priorityRules,
  publicAccessRules,
  reexaminationRules,
  specRules,
  subjectMatterRules,
} from "./core-rules.js";
export { reasoningPatternRules } from "./reasoning-rules.js";
