/**
 * src/patent/checker — 推理模式规则：新颖性组（6 条）。
 *
 * 移植自 Mady domains/workflows/patent/reasoning_patterns.go；按组拆分自
 * reasoning-rules.ts（对齐 core-rules.ts 的按域拆函数范式）。
 */

import type { CheckRule } from "./types.js";
import { LevelMust, LevelShould } from "./types.js";
import {
  TERM_FILING_DATE,
  TERM_INTERNET_DISCLOSURE,
  TERM_NOVELTY,
  TERM_PRIORITY,
  TERM_PRIORITY_DATE,
  TERM_PRIOR_ART,
  TERM_PRIOR_ART_DOC,
  TERM_TECH_EFFECT,
  TERM_TECH_SOLUTION,
  DOMAIN_NOVELTY,
} from "./constants.js";

/** 新颖性推理模式规则（6 条）。 */
export function noveltyReasoningRules(): CheckRule[] {
  return [
    {
      id: "REASON-NOVELTY-01A",
      name: "现有技术认定审查",
      description: "新颖性判断的单独对比+四相同原则",
      level: LevelMust,
      severity: "critical",
      message: "新颖性分析未遵循单独对比和四相同标准",
      checkType: "patent_novelty",
      domain: DOMAIN_NOVELTY,
      pathElements: [
        [TERM_PRIOR_ART, "prior art"],
        ["单独对比", "单独对比原则", "一一对比"],
        ["技术领域", "技术问题", TERM_TECH_SOLUTION, TERM_TECH_EFFECT],
      ],
      singleComparison: true,
      fixSuggestion: "按四相同标准逐一比对：技术领域/技术问题/技术方案/预期效果",
    },
    {
      id: "REASON-NOVELTY-01B",
      name: "四相同标准审查",
      description: "四相同标准中技术方案和效果的全面比对",
      level: LevelShould,
      severity: "major",
      message: "四相同标准分析不完整",
      checkType: "patent_novelty",
      requiredElements: [TERM_TECH_SOLUTION, TERM_TECH_EFFECT],
      domain: DOMAIN_NOVELTY,
      fixSuggestion: "确保技术方案四要素（领域/问题/方案/效果）均得到分析",
    },
    {
      id: "REASON-NOVELTY-02A",
      name: "公开方式判断审查",
      description: "出版物、使用、互联网三种公开方式的认定",
      level: LevelShould,
      severity: "major",
      message: "未充分分析现有技术的公开方式",
      checkType: "patent_public_access",
      domain: DOMAIN_NOVELTY,
      pathElements: [
        ["公开方式", "公开形式", "公开途径"],
        ["申请日", "公开日", TERM_PRIORITY_DATE],
      ],
      fixSuggestion: "明确认定现有技术的公开方式（出版物/使用/互联网）和公开时间",
    },
    {
      id: "REASON-NOVELTY-02B",
      name: "互联网公开认定审查",
      description: "互联网公开的认定及其公开日的确定",
      level: LevelShould,
      severity: "major",
      message: "互联网公开分析不完整",
      checkType: "patent_public_access",
      requiredElements: [TERM_INTERNET_DISCLOSURE, "网络公开"],
      domain: DOMAIN_NOVELTY,
      fixSuggestion: "确认网页公开日的确定方式及公众能够获知的途径",
    },
    {
      id: "REASON-NOVELTY-03A",
      name: "抵触申请审查",
      description: "抵触申请的构成要件及其仅用于新颖性判断的限制",
      level: LevelMust,
      severity: "critical",
      message: "抵触申请分析不完整或误用于创造性判断",
      checkType: "patent_novelty",
      domain: DOMAIN_NOVELTY,
      pathElements: [
        ["抵触申请", "在先申请在后公开", "conflicting application"],
        [TERM_NOVELTY, "新颖性判断"],
      ],
      fixSuggestion: "确认对比文件是否构成抵触申请，仅用于新颖性判断",
    },
    {
      id: "REASON-NOVELTY-03B",
      name: "优先权审查",
      description: "优先权日的认定及其对现有技术判断的影响",
      level: LevelShould,
      severity: "major",
      message: "未充分核实优先权日及其有效性",
      checkType: "patent_novelty",
      domain: DOMAIN_NOVELTY,
      pathElements: [
        [TERM_PRIORITY, TERM_PRIORITY_DATE, "priority date"],
        ["申请日", TERM_FILING_DATE],
        [TERM_PRIOR_ART, TERM_PRIOR_ART_DOC],
      ],
      fixSuggestion: "核实优先权是否有效，以优先权日作为现有技术判断的时间基准",
    },
  ];
}
