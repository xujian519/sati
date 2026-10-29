/**
 * 法律域证据类型（《民事诉讼法》第 66 条八类法定证据）与三性判定契约。
 *
 * 与 `src/patent/evidence/` 分离：专利域证据类型面向现有技术/专利文献/使用公开，
 * 本文件面向诉讼、仲裁中的法定证据种类。两套类型语义不同，不互相扩 enum
 * （扩 `evaluate_evidence` 的 evidenceType 会让专利侧契约变味）。
 */

/** 法定证据种类（《民事诉讼法》第 66 条）。 */
export type LegalEvidenceType =
  | "party_statement"
  | "documentary"
  | "physical"
  | "audio_visual"
  | "electronic"
  | "witness_testimony"
  | "expert_opinion"
  | "inspection_record";

/** 全部法定证据种类（顺序即提示词与 schema 的枚举顺序）。 */
export const LEGAL_EVIDENCE_TYPES: readonly LegalEvidenceType[] = [
  "party_statement",
  "documentary",
  "physical",
  "audio_visual",
  "electronic",
  "witness_testimony",
  "expert_opinion",
  "inspection_record",
];

/** 三维度英文名。 */
export type LegalEvidenceDimension = "relevance" | "legality" | "authenticity";

/** 单维度判定结果。 */
export type LegalEvidenceDimensionJudgment = {
  dimension: LegalEvidenceDimension;
  /** 0–1。 */
  score: number;
  /** high / medium_high / medium / low。 */
  level: string;
  reasoning: string;
};

/** 三性评分。 */
export type LegalEvidenceScore = {
  relevance: number;
  legality: number;
  authenticity: number;
  /** 按权重计算的加权平均分（0–1）。 */
  overall: number;
};

/** 规则检查发现（单条规则的适用结果）。 */
export type LegalEvidenceFinding = {
  ruleId: string;
  passed: boolean;
  reason: string;
  severity: "critical" | "warning" | "info";
};

/** 证据评估输入（调用方提供；自报字段不等同于已核验）。 */
export type LegalEvidenceInput = {
  evidenceId: string;
  evidenceType: LegalEvidenceType;
  source?: string;
  content?: string;
  factToProve?: string;
  hasOriginal?: boolean;
  originalAbsenceReason?: string;
  signatureVerified?: boolean;
  formationTimeClear?: boolean;
  contentHash?: string;
  hashVerified?: boolean;
  timestamp?: string;
  storageIntegrityVerified?: boolean;
  witnessHasConflict?: boolean;
  conflictDisclosed?: boolean;
  corroborated?: boolean;
  expertQualified?: boolean;
  expertProcedureLegal?: boolean;
  expertConclusionClear?: boolean;
  inspectionHasWitness?: boolean;
  inspectionRecordComplete?: boolean;
  collectionLegal?: boolean;
  formLegal?: boolean;
  burdenHolder?: "plaintiff" | "defendant";
  standard?: string;
};

/** 证据评估结果。 */
export type LegalEvidenceAssessment = {
  evidenceId: string;
  evidenceType: LegalEvidenceType;
  score: LegalEvidenceScore;
  dimensions: {
    relevance: LegalEvidenceDimensionJudgment;
    legality: LegalEvidenceDimensionJudgment;
    authenticity: LegalEvidenceDimensionJudgment;
  };
  findings: LegalEvidenceFinding[];
  burdenHolder?: "plaintiff" | "defendant";
  standard?: string;
  reasoning: string;
};

/** 证据规则（`rules/legal/legal-evidence-rules.yaml` 条目形态）。 */
export type LegalEvidenceRule = {
  id: string;
  description: string;
  evidenceType: LegalEvidenceType | "general";
  check: string;
  severity: "critical" | "warning" | "info";
  legalBasis?: string;
  conditions?: string[];
};

/** 完整规则集（YAML 顶层形态）。 */
export type LegalEvidenceRuleSet = {
  weights: { relevance: number; legality: number; authenticity: number };
  rules: LegalEvidenceRule[];
};

/** 证据判定器接口。 */
export interface LegalEvidenceEvaluator {
  evaluateRelevance(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment;
  evaluateLegality(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment;
  evaluateAuthenticity(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment;
  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[];
}
