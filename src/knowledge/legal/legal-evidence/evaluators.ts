/**
 * 八类法定证据的三性判定器（移植自 dsh legal-evidence 的 evaluators，改写为 strict TS）。
 *
 * 判定只使用证据记录与调用方声明：0–1 确定性评分，无模型调用。
 * 关联性对全部类型共用一套评分；合法性缺省走通用评分，类型特有要点单独覆盖；
 * 真实性按类型分派。
 */

import type {
  LegalEvidenceDimensionJudgment,
  LegalEvidenceEvaluator,
  LegalEvidenceFinding,
  LegalEvidenceInput,
  LegalEvidenceType,
} from "./types.js";

/** 三性评分基线（证据记录本身的完备度起点）。 */
export const TRIPLE_ATTRIBUTE_BASE = 0.5;

/** 字段是否填写了非空白内容。 */
export function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/** 0–1 评分 → 等级。 */
export function levelFor(score: number): string {
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium_high";
  if (score >= 0.45) return "medium";
  return "low";
}

function clamp(score: number): number {
  return Math.max(0, Math.min(score, 1));
}

/** 组装判定器：关联性固定为通用评分，合法性/真实性可覆盖。 */
function createEvaluator(parts: {
  assessAuthenticity: (input: LegalEvidenceInput) => LegalEvidenceDimensionJudgment;
  assessLegality?: (input: LegalEvidenceInput) => LegalEvidenceDimensionJudgment;
  checkFindings: (input: LegalEvidenceInput) => LegalEvidenceFinding[];
}): LegalEvidenceEvaluator {
  return {
    evaluateRelevance: evaluateGenericRelevance,
    evaluateLegality: parts.assessLegality ?? evaluateGenericLegality,
    evaluateAuthenticity: parts.assessAuthenticity,
    checkFindings: parts.checkFindings,
  };
}

/** 通用关联性：待证事实明确性 + 证据内容 + 来源记录。 */
export function evaluateGenericRelevance(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment {
  let score = TRIPLE_ATTRIBUTE_BASE;
  const reasons: string[] = [];
  if (hasText(input.factToProve)) {
    score += 0.15;
    reasons.push("已明确待证事实");
  }
  if (hasText(input.content)) {
    score += 0.15;
    reasons.push("已提供证据内容");
  }
  if (hasText(input.source)) {
    score += 0.1;
    reasons.push("已记录证据来源");
  }
  score = clamp(score);
  return {
    dimension: "relevance",
    score,
    level: levelFor(score),
    reasoning: reasons.length > 0 ? `关联性评估：${reasons.join("；")}` : "关联性评估：基础评分",
  };
}

/** 通用合法性：收集合法性 + 形式合法性 + 来源记录。 */
export function evaluateGenericLegality(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment {
  let score = TRIPLE_ATTRIBUTE_BASE;
  const reasons: string[] = [];
  if (input.collectionLegal === true) {
    score += 0.25;
    reasons.push("证据收集合法");
  } else if (input.collectionLegal === false) {
    score -= 0.2;
    reasons.push("证据收集合法性存疑");
  }
  if (input.formLegal === true) {
    score += 0.2;
    reasons.push("证据形式合法");
  } else if (input.formLegal === false) {
    score -= 0.15;
    reasons.push("证据形式合法性存疑");
  }
  if (hasText(input.source)) {
    score += 0.05;
    reasons.push("已记录证据来源");
  }
  score = clamp(score);
  return {
    dimension: "legality",
    score,
    level: levelFor(score),
    reasoning: reasons.length > 0 ? `合法性评估：${reasons.join("；")}` : "合法性评估：基础评分",
  };
}

// ---------------------------------------------------------------------------
// 书证（第 66 条第 2 项）
// ---------------------------------------------------------------------------

export const documentaryEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.hasOriginal === true) {
      score += 0.2;
      reasons.push("已提供原件");
    } else if (input.hasOriginal === false) {
      if (hasText(input.originalAbsenceReason)) {
        score += 0.05;
        reasons.push("未提供原件但有合理说明");
      } else {
        score -= 0.15;
        reasons.push("未提供原件且未说明原因");
      }
    }
    if (input.signatureVerified === true) {
      score += 0.2;
      reasons.push("签章已核验");
    } else if (input.signatureVerified === false) {
      score -= 0.2;
      reasons.push("签章真实性未核验");
    }
    if (input.formationTimeClear === true) {
      score += 0.1;
      reasons.push("形成时间明确");
    } else if (input.formationTimeClear === false) {
      score -= 0.1;
      reasons.push("形成时间不明确");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `书证真实性评估：${reasons.join("；")}` : "书证真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.hasOriginal !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-001",
        passed: false,
        reason: hasText(input.originalAbsenceReason)
          ? `未提供原件，但已说明原因：${input.originalAbsenceReason}`
          : "书证应提供原件，未提供且未说明原因",
        severity: "critical",
      });
    } else {
      findings.push({ ruleId: "LEGAL-EVI-001", passed: true, reason: "已提供原件", severity: "info" });
    }
    if (input.signatureVerified !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-002",
        passed: false,
        reason: "书证签章真实性未核验",
        severity: "warning",
      });
    }
    if (input.formationTimeClear !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-003",
        passed: false,
        reason: "书证形成时间不明确，可能影响证据效力",
        severity: "warning",
      });
    }
    return findings;
  },
});

// ---------------------------------------------------------------------------
// 电子数据（第 66 条第 5 项）
// ---------------------------------------------------------------------------

export const electronicEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessLegality(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.collectionLegal === true) {
      score += 0.25;
      reasons.push("电子数据收集程序合法");
    } else if (input.collectionLegal === false) {
      score -= 0.3;
      reasons.push("电子数据收集程序合法性存疑");
    }
    if (input.formLegal === true) {
      score += 0.2;
      reasons.push("电子数据形式合法");
    }
    if (hasText(input.source)) {
      score += 0.1;
      reasons.push("已记录电子数据来源");
    }
    score = clamp(score);
    return {
      dimension: "legality",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `电子数据合法性评估：${reasons.join("；")}` : "电子数据合法性评估：基础评分",
    };
  },
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (hasText(input.contentHash)) {
      score += 0.15;
      reasons.push("已记录内容哈希");
      if (input.hashVerified === true) {
        score += 0.2;
        reasons.push("哈希已独立核验");
      } else if (input.hashVerified === false) {
        score -= 0.1;
        reasons.push("哈希未独立核验");
      }
    } else {
      score -= 0.1;
      reasons.push("未记录内容哈希");
    }
    if (hasText(input.timestamp)) {
      score += 0.1;
      reasons.push("已记录时间戳");
    } else {
      score -= 0.05;
      reasons.push("未记录时间戳");
    }
    if (input.storageIntegrityVerified === true) {
      score += 0.15;
      reasons.push("存储完整性已核验");
    } else if (input.storageIntegrityVerified === false) {
      score -= 0.15;
      reasons.push("存储完整性未核验");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: `电子数据真实性评估：${reasons.join("；")}`,
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.storageIntegrityVerified !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-004",
        passed: false,
        reason: "电子数据存储完整性未核验",
        severity: "critical",
      });
    } else {
      findings.push({
        ruleId: "LEGAL-EVI-004",
        passed: true,
        reason: "电子数据存储完整性已核验",
        severity: "info",
      });
    }
    if (!hasText(input.contentHash)) {
      findings.push({ ruleId: "LEGAL-EVI-005", passed: false, reason: "电子数据未记录内容哈希", severity: "warning" });
    } else if (input.hashVerified !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-005",
        passed: false,
        reason: "电子数据内容哈希未独立核验",
        severity: "warning",
      });
    }
    if (!hasText(input.timestamp)) {
      findings.push({ ruleId: "LEGAL-EVI-006", passed: false, reason: "电子数据未记录时间戳", severity: "warning" });
    }
    return findings;
  },
});

// ---------------------------------------------------------------------------
// 证人证言（第 66 条第 6 项）
// ---------------------------------------------------------------------------

export const witnessTestimonyEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessLegality(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.collectionLegal === true) {
      score += 0.25;
      reasons.push("证人证言收集程序合法");
    } else if (input.collectionLegal === false) {
      score -= 0.3;
      reasons.push("证人证言收集程序合法性存疑");
    }
    if (input.formLegal === true) {
      score += 0.2;
      reasons.push("证人证言形式合法");
    }
    if (hasText(input.source)) {
      score += 0.05;
      reasons.push("已记录证人身份");
    }
    score = clamp(score);
    return {
      dimension: "legality",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `证人证言合法性评估：${reasons.join("；")}` : "证人证言合法性评估：基础评分",
    };
  },
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.witnessHasConflict === true) {
      if (input.conflictDisclosed === true) {
        score += 0.05;
        reasons.push("证人有利害关系但已披露");
      } else {
        score -= 0.2;
        reasons.push("证人有利害关系且未披露");
      }
    } else if (input.witnessHasConflict === false) {
      score += 0.15;
      reasons.push("证人与案件无利害关系");
    }
    if (input.corroborated === true) {
      score += 0.2;
      reasons.push("证人证言有其他证据佐证");
    } else if (input.corroborated === false) {
      score -= 0.15;
      reasons.push("证人证言缺乏佐证");
    }
    if (hasText(input.content)) {
      score += 0.1;
      reasons.push("已记录证言内容");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `证人证言真实性评估：${reasons.join("；")}` : "证人证言真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.witnessHasConflict === true && input.conflictDisclosed !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-007",
        passed: false,
        reason: "证人与案件有利害关系且未披露",
        severity: "critical",
      });
    } else if (input.witnessHasConflict === true) {
      findings.push({ ruleId: "LEGAL-EVI-007", passed: true, reason: "证人有利害关系但已披露", severity: "info" });
    } else {
      findings.push({ ruleId: "LEGAL-EVI-007", passed: true, reason: "证人与案件无利害关系", severity: "info" });
    }
    if (input.corroborated !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-008",
        passed: false,
        reason: "证人证言缺乏其他证据佐证",
        severity: "warning",
      });
    }
    return findings;
  },
});

// ---------------------------------------------------------------------------
// 鉴定意见（第 66 条第 7 项）
// ---------------------------------------------------------------------------

export const expertOpinionEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessLegality(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.expertQualified === true) {
      score += 0.3;
      reasons.push("鉴定机构/鉴定人资质已核验");
    } else if (input.expertQualified === false) {
      score -= 0.3;
      reasons.push("鉴定机构/鉴定人资质未核验");
    }
    if (input.expertProcedureLegal === true) {
      score += 0.2;
      reasons.push("鉴定程序合法");
    } else if (input.expertProcedureLegal === false) {
      score -= 0.25;
      reasons.push("鉴定程序合法性存疑");
    }
    score = clamp(score);
    return {
      dimension: "legality",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `鉴定意见合法性评估：${reasons.join("；")}` : "鉴定意见合法性评估：基础评分",
    };
  },
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.expertConclusionClear === true) {
      score += 0.25;
      reasons.push("鉴定结论明确");
    } else if (input.expertConclusionClear === false) {
      score -= 0.2;
      reasons.push("鉴定结论不明确");
    }
    if (hasText(input.content)) {
      score += 0.1;
      reasons.push("已记录鉴定材料");
    }
    if (input.expertQualified === true) {
      score += 0.15;
      reasons.push("鉴定资质已核验");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `鉴定意见真实性评估：${reasons.join("；")}` : "鉴定意见真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.expertQualified !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-009",
        passed: false,
        reason: "鉴定机构/鉴定人资质未核验",
        severity: "critical",
      });
    } else {
      findings.push({
        ruleId: "LEGAL-EVI-009",
        passed: true,
        reason: "鉴定机构/鉴定人资质已核验",
        severity: "info",
      });
    }
    if (input.expertProcedureLegal !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-010",
        passed: false,
        reason: "鉴定程序合法性未确认",
        severity: "critical",
      });
    }
    if (input.expertConclusionClear !== true) {
      findings.push({ ruleId: "LEGAL-EVI-011", passed: false, reason: "鉴定结论不明确", severity: "warning" });
    }
    return findings;
  },
});

// ---------------------------------------------------------------------------
// 当事人陈述 / 物证 / 视听资料 / 勘验笔录
// ---------------------------------------------------------------------------

export const partyStatementEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (hasText(input.content)) {
      score += 0.15;
      reasons.push("已记录陈述内容");
    }
    if (input.corroborated === true) {
      score += 0.2;
      reasons.push("有其他证据佐证");
    } else if (input.corroborated === false) {
      score -= 0.15;
      reasons.push("缺乏其他证据佐证");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `当事人陈述真实性评估：${reasons.join("；")}` : "当事人陈述真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.corroborated !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-012",
        passed: false,
        reason: "当事人陈述缺乏其他证据佐证",
        severity: "warning",
      });
    }
    return findings;
  },
});

export const physicalEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.hasOriginal === true) {
      score += 0.25;
      reasons.push("已提供原物");
    } else if (input.hasOriginal === false) {
      if (hasText(input.originalAbsenceReason)) {
        score += 0.05;
        reasons.push("未提供原物但有合理说明");
      } else {
        score -= 0.15;
        reasons.push("未提供原物且未说明原因");
      }
    }
    if (input.storageIntegrityVerified === true) {
      score += 0.15;
      reasons.push("物证保管链完整");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `物证真实性评估：${reasons.join("；")}` : "物证真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.hasOriginal !== true) {
      findings.push({
        ruleId: "LEGAL-EVI-013",
        passed: false,
        reason: "物证应提供原物，未提供且未说明原因",
        severity: "warning",
      });
    }
    return findings;
  },
});

export const audioVisualEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (hasText(input.contentHash)) {
      score += 0.15;
      reasons.push("已记录内容哈希");
      if (input.hashVerified === true) {
        score += 0.15;
        reasons.push("哈希已核验");
      }
    }
    if (input.storageIntegrityVerified === true) {
      score += 0.15;
      reasons.push("存储完整性已核验");
    }
    if (hasText(input.timestamp)) {
      score += 0.1;
      reasons.push("已记录时间信息");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `视听资料真实性评估：${reasons.join("；")}` : "视听资料真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (!hasText(input.contentHash)) {
      findings.push({ ruleId: "LEGAL-EVI-014", passed: false, reason: "视听资料未记录内容哈希", severity: "warning" });
    }
    return findings;
  },
});

export const inspectionRecordEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE;
    const reasons: string[] = [];
    if (input.inspectionHasWitness === true) {
      score += 0.2;
      reasons.push("勘验有见证人在场");
    } else if (input.inspectionHasWitness === false) {
      score -= 0.15;
      reasons.push("勘验无见证人在场");
    }
    if (input.inspectionRecordComplete === true) {
      score += 0.2;
      reasons.push("勘验记录完整");
    } else if (input.inspectionRecordComplete === false) {
      score -= 0.15;
      reasons.push("勘验记录不完整");
    }
    score = clamp(score);
    return {
      dimension: "authenticity",
      score,
      level: levelFor(score),
      reasoning: reasons.length > 0 ? `勘验笔录真实性评估：${reasons.join("；")}` : "勘验笔录真实性评估：基础评分",
    };
  },
  checkFindings(input) {
    const findings: LegalEvidenceFinding[] = [];
    if (input.inspectionHasWitness !== true) {
      findings.push({ ruleId: "LEGAL-EVI-015", passed: false, reason: "勘验无见证人在场", severity: "warning" });
    }
    if (input.inspectionRecordComplete !== true) {
      findings.push({ ruleId: "LEGAL-EVI-016", passed: false, reason: "勘验记录不完整", severity: "warning" });
    }
    return findings;
  },
});

const EVALUATORS: Record<LegalEvidenceType, LegalEvidenceEvaluator> = {
  party_statement: partyStatementEvaluator,
  documentary: documentaryEvaluator,
  physical: physicalEvaluator,
  audio_visual: audioVisualEvaluator,
  electronic: electronicEvaluator,
  witness_testimony: witnessTestimonyEvaluator,
  expert_opinion: expertOpinionEvaluator,
  inspection_record: inspectionRecordEvaluator,
};

/** 按证据类型取判定器。 */
export function getLegalEvidenceEvaluator(evidenceType: LegalEvidenceType): LegalEvidenceEvaluator {
  return EVALUATORS[evidenceType];
}
