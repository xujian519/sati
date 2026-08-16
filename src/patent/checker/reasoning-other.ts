/**
 * src/patent/checker — 推理模式规则：其他组（6 条）。
 *
 * 移植自 Mady domains/workflows/patent/reasoning_patterns.go；按组拆分自
 * reasoning-rules.ts（对齐 core-rules.ts 的按域拆函数范式）。
 */

import type { CheckRule } from "./types.js";
import { LevelMust, LevelShould } from "./types.js";
import {
  TERM_CAN_USE,
  TERM_DESIGN_PATENT,
  TERM_FILING_DATE,
  TERM_MENTAL_ACTIVITY,
  TERM_NATURAL_LAW,
  TERM_OVERALL_VISUAL,
  TERM_PRIORITY,
  TERM_PRIORITY_DATE,
  TERM_PRODUCT_CATEGORY,
  TERM_SCI_DISCOVERY,
  TERM_TECH_SOLUTION,
  DOMAIN_AMENDMENT,
  DOMAIN_DESIGN,
  DOMAIN_EXAMINATION,
} from "./constants.js";

/** 其他推理模式规则（6 条）。 */
export function otherReasoningRules(): CheckRule[] {
  return [
    {
      id: "REASON-OTHER-01A",
      name: "保护客体-技术方案认定审查",
      description: "第2条可专利主题判断",
      level: LevelMust,
      severity: "critical",
      message: "保护客体分析不完整，未充分论证是否构成技术方案",
      checkType: "patent_subject_matter",
      domain: DOMAIN_EXAMINATION,
      pathElements: [
        [TERM_TECH_SOLUTION, "technical solution"],
        [TERM_NATURAL_LAW, "自然法则"],
        ["保护客体", "可专利主题", "授权客体", "patentable subject matter"],
      ],
      fixSuggestion: "论证是否构成技术方案（利用自然规律、解决技术问题、产生技术效果），并排除非可专利客体",
    },
    {
      id: "REASON-OTHER-01B",
      name: "非可专利客体排除审查",
      description: "排除科学发现/智力活动规则/疾病诊断治疗方法的论证",
      level: LevelShould,
      severity: "major",
      message: "未充分分析是否属于非可专利客体",
      checkType: "patent_subject_matter",
      requiredElements: [TERM_SCI_DISCOVERY, TERM_MENTAL_ACTIVITY, "疾病诊断方法"],
      domain: DOMAIN_EXAMINATION,
      fixSuggestion: "逐项排除：科学发现、智力活动规则、疾病诊断治疗方法、原子核变换方法",
    },
    {
      id: "REASON-OTHER-02A",
      name: "修改超范围审查",
      description: "修改内容是否超出原申请文件记载范围",
      level: LevelMust,
      severity: "critical",
      message: "修改超范围分析不完整",
      checkType: "patent_amendment_scope",
      domain: DOMAIN_AMENDMENT,
      pathElements: [
        ["修改超范围", "超范围", "超出原范围", "超范围修改", "amendment beyond scope"],
        ["直接且毫无疑义", "直接毫无疑义", "原申请文件"],
        ["原说明书", "原权利要求", "原始公开"],
      ],
      fixSuggestion: "确认修改内容是否能够从原说明书和权利要求书记载的范围中直接且毫无疑义地确定",
    },
    {
      id: "REASON-OTHER-02B",
      name: "优先权程序审查",
      description: "优先权转让及主张的程序合规性",
      level: LevelShould,
      severity: "major",
      message: "优先权程序审查不完整",
      checkType: "patent_amendment_scope",
      domain: DOMAIN_AMENDMENT,
      pathElements: [
        [TERM_PRIORITY, TERM_PRIORITY_DATE, "优先权转让"],
        ["申请日", TERM_FILING_DATE],
        ["转让", "transfer", "assign"],
      ],
      fixSuggestion: "核实优先权转让是否在申请日前完成，优先权主张是否符合程序要求",
    },
    {
      id: "REASON-OTHER-03",
      name: "实用性-积极效果与产业应用审查",
      description: "第22条第4款实用性判断",
      level: LevelShould,
      severity: "major",
      message: "实用性分析不完整",
      checkType: "patent_subject_matter",
      domain: DOMAIN_EXAMINATION,
      pathElements: [
        ["实用性", "工业实用性", "产业应用", "industrial applicability"],
        ["能够制造", TERM_CAN_USE],
        ["积极效果", "有益效果", "positive effect"],
      ],
      fixSuggestion: "论证本领域技术人员能够在产业上制造或使用该发明，并产生积极效果",
    },
    {
      id: "REASON-OTHER-04",
      name: "整体视觉效果对比审查",
      description: "外观设计四步推理结构：产品种类→整体视觉→相同/近似判断",
      level: LevelShould,
      severity: "major",
      message: "外观设计对比分析不完整，缺少整体视觉效果判断",
      checkType: "patent_design_comparison",
      domain: DOMAIN_DESIGN,
      pathElements: [
        [TERM_DESIGN_PATENT, "工业设计", "design", "industrial design"],
        [TERM_OVERALL_VISUAL, "视觉效果", "整体外观", "整体视觉", "overall visual effect"],
        [TERM_PRODUCT_CATEGORY, "产品类别", "同类产品", "相近种类"],
        ["相同", "近似", "实质相同"],
      ],
      fixSuggestion: "按四步结构分析：确定产品种类→明确整体视觉效果→对比整体视觉效果→判断相同/近似",
    },
  ];
}
