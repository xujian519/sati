/**
 * `evaluate_legal_evidence` — 法律域八类法定证据的三性判定工具。
 *
 * 与 `evaluate_evidence`（专利域）分列：证据类型体系不同（《民事诉讼法》第 66 条
 * 八类 vs 专利现有技术/使用公开 15 类），共用一个工具会让两边 enum 与语义互相
 * 稀释。本工具复用同一套"确定性评分 + 规则检查"思路，但不改专利侧契约。
 */

import type { SatiToolDefinition } from "../../../tool/protocol/types.js";
import { LegalEvidenceEngine } from "./engine.js";
import { loadLegalEvidenceRulesEngine } from "./rule-loader.js";
import {
  LEGAL_EVIDENCE_TYPES,
  type LegalEvidenceAssessment,
  type LegalEvidenceInput,
  type LegalEvidenceType,
} from "./types.js";

export type EvaluateLegalEvidenceInput = LegalEvidenceInput;

export type EvaluateLegalEvidenceOutput = {
  assessment: LegalEvidenceAssessment;
  summary: string;
  /** 规则资产是否加载成功（false → 只有默认权重，规则检查项缺失）。 */
  rulesLoaded: boolean;
  /** 规则资产加载警告（降级原因；不静默）。 */
  warnings: string[];
};

const DESCRIPTION =
  "评估法律证据的三性（关联性、合法性、真实性），按《民事诉讼法》第 66 条八类法定证据分别判定。" +
  "输入证据 id、证据类型与相关属性，输出三性评分（0-1）、各维度判定详情与规则检查发现。" +
  "证据类型：当事人陈述/书证/物证/视听资料/电子数据/证人证言/鉴定意见/勘验笔录。" +
  "确定性评分，无模型调用。书证应提供原件并核验签章；电子数据应记录哈希并核验完整性；" +
  "证人证言应披露利害关系并有佐证；鉴定意见应核验资质与程序。评分低于 0.5 需补强或另行举证。" +
  "与专利证据工具 evaluate_evidence 分列：本工具只服务诉讼/仲裁中的法定证据，不得用于现有技术抗辩。";

/** 单维度 schema（三性共用）。 */
const DIMENSION_SCHEMA = {
  type: "object",
  required: ["dimension", "score", "level", "reasoning"],
  properties: {
    dimension: { type: "string" },
    score: { type: "number" },
    level: { type: "string" },
    reasoning: { type: "string" },
  },
} as const;

export function createEvaluateLegalEvidenceTool(deps?: {
  engine?: LegalEvidenceEngine;
}): SatiToolDefinition<EvaluateLegalEvidenceInput, EvaluateLegalEvidenceOutput> {
  // 惰性加载：首次 execute 才读盘（注册表构建/网关启动不支付文件 IO）。
  let loaded: { engine: LegalEvidenceEngine; warnings: string[]; loaded: boolean } | undefined;
  const resolveEngine = () => {
    if (loaded === undefined) {
      const result =
        deps?.engine !== undefined
          ? { engine: deps.engine, warnings: [] as string[], source: null }
          : loadLegalEvidenceRulesEngine();
      loaded = { engine: result.engine, warnings: result.warnings, loaded: result.source !== null };
    }
    return loaded;
  };

  return {
    name: "evaluate_legal_evidence",
    outputSchema: {
      type: "object",
      required: ["assessment", "summary", "rulesLoaded", "warnings"],
      properties: {
        summary: { type: "string" },
        rulesLoaded: { type: "boolean" },
        warnings: { type: "array", items: { type: "string" } },
        assessment: {
          type: "object",
          required: ["evidenceId", "evidenceType", "score", "dimensions", "findings", "reasoning"],
          properties: {
            evidenceId: { type: "string" },
            evidenceType: { type: "string" },
            score: {
              type: "object",
              required: ["relevance", "legality", "authenticity", "overall"],
              properties: {
                relevance: { type: "number" },
                legality: { type: "number" },
                authenticity: { type: "number" },
                overall: { type: "number" },
              },
            },
            dimensions: {
              type: "object",
              required: ["relevance", "legality", "authenticity"],
              properties: {
                relevance: DIMENSION_SCHEMA,
                legality: DIMENSION_SCHEMA,
                authenticity: DIMENSION_SCHEMA,
              },
            },
            findings: {
              type: "array",
              items: {
                type: "object",
                required: ["ruleId", "passed", "reason", "severity"],
                properties: {
                  ruleId: { type: "string" },
                  passed: { type: "boolean" },
                  reason: { type: "string" },
                  severity: { type: "string", enum: ["critical", "warning", "info"] },
                },
              },
            },
            burdenHolder: { type: "string", enum: ["plaintiff", "defendant"] },
            standard: { type: "string" },
            reasoning: { type: "string" },
          },
        },
      },
    },
    title: "Evaluate Legal Evidence",
    description: DESCRIPTION,
    kind: "custom",
    domain: "legal",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["evidenceId", "evidenceType"],
      properties: {
        evidenceId: { type: "string", description: "证据 id（唯一标识，如 证据1 / E-01）。" },
        evidenceType: { type: "string", enum: [...LEGAL_EVIDENCE_TYPES], description: "法定证据类型。" },
        source: { type: "string", description: "证据来源描述（书证来源、物证来源、证人身份等）。" },
        content: { type: "string", description: "证据内容摘要或原文。" },
        factToProve: { type: "string", description: "该证据欲证明的事实。" },
        hasOriginal: { type: "boolean", description: "是否提供原件/原物（书证、物证）。" },
        originalAbsenceReason: { type: "string", description: "未提供原件/原物的原因说明。" },
        signatureVerified: { type: "boolean", description: "书证签章/签名是否已核验。" },
        formationTimeClear: { type: "boolean", description: "书证形成时间是否明确。" },
        contentHash: { type: "string", description: "内容哈希（电子数据/视听资料）。" },
        hashVerified: { type: "boolean", description: "哈希是否已独立核验。" },
        timestamp: { type: "string", description: "时间戳（电子数据/视听资料）。" },
        storageIntegrityVerified: { type: "boolean", description: "存储完整性/保管链是否已核验。" },
        witnessHasConflict: { type: "boolean", description: "证人与案件是否有利害关系。" },
        conflictDisclosed: { type: "boolean", description: "利害关系是否已披露。" },
        corroborated: { type: "boolean", description: "是否有其他证据佐证（证人证言/当事人陈述）。" },
        expertQualified: { type: "boolean", description: "鉴定机构/鉴定人资质是否已核验。" },
        expertProcedureLegal: { type: "boolean", description: "鉴定程序是否合法。" },
        expertConclusionClear: { type: "boolean", description: "鉴定结论是否明确。" },
        inspectionHasWitness: { type: "boolean", description: "勘验是否有见证人在场。" },
        inspectionRecordComplete: { type: "boolean", description: "勘验记录是否完整。" },
        collectionLegal: { type: "boolean", description: "证据收集主体/程序是否合法。" },
        formLegal: { type: "boolean", description: "证据形式是否合法。" },
        burdenHolder: { type: "string", enum: ["plaintiff", "defendant"], description: "举证责任方。" },
        standard: { type: "string", description: "证明标准（如 优势证据 / 高度盖然性）。" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const { engine, warnings, loaded: rulesLoaded } = resolveEngine();
      const evidenceId = input.evidenceId.trim();
      if (evidenceId === "") {
        return {
          content: [{ type: "text", text: "错误：evidenceId 不能为空，未执行评估。" }],
          metadata: { error: "no_evidence_id" },
        };
      }
      const evidenceType = input.evidenceType as LegalEvidenceType;
      const assessment = engine.assess({ ...input, evidenceId, evidenceType });
      const output: EvaluateLegalEvidenceOutput = {
        assessment,
        summary: buildSummary(assessment, rulesLoaded),
        rulesLoaded,
        warnings,
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
        metadata: {
          domain: "legal",
          rulesLoaded,
          ...(warnings.length > 0 ? { degraded: true } : {}),
        },
      };
    },
  };
}

/** 人类可读摘要（同时进入 content，便于模型直接引用）。 */
function buildSummary(assessment: LegalEvidenceAssessment, rulesLoaded: boolean): string {
  const { score, findings } = assessment;
  const critical = findings.filter(f => !f.passed && f.severity === "critical");
  const warning = findings.filter(f => !f.passed && f.severity === "warning");
  const parts: string[] = [
    `证据 ${assessment.evidenceId}（${assessment.evidenceType}）三性评估：`,
    `  关联性 ${score.relevance.toFixed(2)}，合法性 ${score.legality.toFixed(2)}，真实性 ${score.authenticity.toFixed(2)}`,
    `  综合评分 ${score.overall.toFixed(2)}`,
  ];
  if (critical.length > 0) parts.push(`  严重问题 ${critical.length} 项：${critical.map(f => f.reason).join("；")}`);
  if (warning.length > 0) parts.push(`  警告 ${warning.length} 项：${warning.map(f => f.reason).join("；")}`);
  if (score.overall < 0.5) parts.push("  建议：评分偏低，需补强证据或另行举证。");
  if (!rulesLoaded) parts.push("  注意：规则资产未加载，本次只有默认权重评分，规则检查项缺失。");
  return parts.join("\n");
}
