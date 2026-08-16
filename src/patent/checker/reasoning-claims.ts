/**
 * src/patent/checker — 推理模式规则：权利要求/说明书组（5 条）。
 *
 * 移植自 Mady domains/workflows/patent/reasoning_patterns.go；按组拆分自
 * reasoning-rules.ts（对齐 core-rules.ts 的按域拆函数范式）。
 */

import type { CheckRule } from "./types.js";
import { LevelShould } from "./types.js";
import {
  TERM_CAN_USE,
  TERM_ENABLEMENT,
  TERM_EXP_DATA,
  TERM_FUNCTIONAL_LIMIT,
  TERM_PROTECTION_SCOPE,
  TERM_TECH_EFFECT,
  TERM_TECH_SOLUTION,
  DOMAIN_CLAIMS,
  DOMAIN_DISCLOSURE,
  DIM_CLARITY,
  DIM_SUPPORT,
} from "./constants.js";

/** 权利要求/说明书推理模式规则（5 条）。 */
export function claimsReasoningRules(): CheckRule[] {
  return [
    {
      id: "REASON-CLAIMS-01",
      name: "不清楚认定审查",
      description: "权利要求保护范围的清楚性判断",
      level: LevelShould,
      severity: "major",
      message: "权利要求不清楚性分析不完整",
      checkType: "patent_claim_analysis",
      domain: DOMAIN_CLAIMS,
      dimensions: [DIM_CLARITY],
      pathElements: [
        ["清楚", "清晰", "明确", "简要"],
        ["权利要求", TERM_PROTECTION_SCOPE],
        ["含义不确定", "术语含义不明"],
      ],
      fixSuggestion: "逐一审查权利要求每个术语的含义是否明确，删除含义不确定的表述",
    },
    {
      id: "REASON-CLAIMS-02",
      name: "不支持认定审查",
      description: "权利要求是否得到说明书支持",
      level: LevelShould,
      severity: "major",
      message: "权利要求未充分分析是否得到说明书支持",
      checkType: "patent_claim_analysis",
      domain: DOMAIN_CLAIMS,
      dimensions: [DIM_SUPPORT],
      pathElements: [
        ["以说明书为依据", "说明书支持", "支持"],
        ["合理概括", "概括范围"],
        ["权利要求", TERM_PROTECTION_SCOPE],
      ],
      fixSuggestion: "比对权利要求与说明书的具体实施方式和实施例，确认概括范围是否合理",
    },
    {
      id: "REASON-CLAIMS-03",
      name: "功能性限定审查",
      description: "功能性限定的解释范围与审查规则",
      level: LevelShould,
      severity: "major",
      message: "未充分分析功能性限定的解释范围",
      checkType: "patent_claim_analysis",
      domain: DOMAIN_CLAIMS,
      pathElements: [
        [TERM_FUNCTIONAL_LIMIT, "功能限定", "功能性特征", "functional limitation"],
        ["具体实施方式", "实施例"],
        [TERM_PROTECTION_SCOPE, "解释范围"],
      ],
      fixSuggestion: "确认说明书记载了实现该功能的具体实施方式，以此限定功能性特征的保护范围",
    },
    {
      id: "REASON-CLAIMS-04",
      name: "充分公开认定审查",
      description: "能够实现标准的审查逻辑",
      level: LevelShould,
      severity: "major",
      message: "充分公开分析未完整覆盖能够实现标准的审查维度",
      checkType: "patent_disclosure",
      domain: DOMAIN_DISCLOSURE,
      pathElements: [
        ["充分公开", "公开充分", TERM_ENABLEMENT],
        ["能够实现", "可实施", "能够制造", TERM_CAN_USE],
        [TERM_TECH_SOLUTION, TERM_TECH_EFFECT],
      ],
      fixSuggestion: "从技术方案完整性、可实施性、技术效果三个维度论证充分公开",
    },
    {
      id: "REASON-CLAIMS-05",
      name: "实验数据要求审查",
      description: "医药化学领域实验数据的满足度判断",
      level: LevelShould,
      severity: "major",
      message: "实验数据满足度分析不充分",
      checkType: "patent_disclosure",
      domain: DOMAIN_DISCLOSURE,
      pathElements: [
        [TERM_EXP_DATA, "实验例", "试验数据"],
        ["能够实现", "证实", "证明", "验证"],
        ["充分公开", "公开充分"],
      ],
      fixSuggestion: "审查实验数据是否足以证明技术方案能够实现所述用途/效果，数据是否可重现",
    },
  ];
}
