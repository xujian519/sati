/**
 * 法律域证据规则集的 YAML 解析与校验。
 *
 * 容错面向资产作者：单条坏规则只累积一条警告并跳过，不阻塞整体加载；引擎随后
 * 用默认权重与已解析的规则子集继续判定。
 */

import { parseDocument } from "yaml";
import {
  LEGAL_EVIDENCE_TYPES,
  type LegalEvidenceRule,
  type LegalEvidenceRuleSet,
  type LegalEvidenceType,
} from "./types.js";

/** 三维度权重缺省值（资产缺失或字段非法时逐字段回退）。 */
export const DEFAULT_LEGAL_WEIGHTS = { relevance: 0.35, legality: 0.3, authenticity: 0.35 };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: readonly unknown[]): string[] {
  return value.filter((v): v is string => typeof v === "string");
}

function isKnownEvidenceType(value: string): value is LegalEvidenceType | "general" {
  return value === "general" || (LEGAL_EVIDENCE_TYPES as readonly string[]).includes(value);
}

/**
 * 解析法律域证据规则集。
 *
 * @param yamlText - `legal-evidence-rules.yaml` 全文。
 * @param source - 资产路径，仅用于警告文本。
 * @returns 规则集（顶层不是对象时为 null）与累积警告。
 */
export function parseLegalRuleSet(
  yamlText: string,
  source: string,
): { ruleSet: LegalEvidenceRuleSet | null; warnings: string[] } {
  const warnings: string[] = [];
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    warnings.push(`法律证据规则 YAML 解析失败 ${source}: ${doc.errors.map(e => e.message).join("; ")}`);
    return { ruleSet: null, warnings };
  }
  const root = asRecord(doc.toJS());
  if (root === null) {
    warnings.push(`法律证据规则文件顶层必须是对象 ${source}`);
    return { ruleSet: null, warnings };
  }
  const weightsRaw = asRecord(root.weights);
  const weights = {
    relevance: typeof weightsRaw?.relevance === "number" ? weightsRaw.relevance : DEFAULT_LEGAL_WEIGHTS.relevance,
    legality: typeof weightsRaw?.legality === "number" ? weightsRaw.legality : DEFAULT_LEGAL_WEIGHTS.legality,
    authenticity:
      typeof weightsRaw?.authenticity === "number" ? weightsRaw.authenticity : DEFAULT_LEGAL_WEIGHTS.authenticity,
  };

  const rules: LegalEvidenceRule[] = [];
  const rawRules = root.rules;
  if (!Array.isArray(rawRules)) {
    warnings.push(`法律证据规则文件缺少 rules 数组 ${source}`);
    return { ruleSet: { weights, rules }, warnings };
  }
  for (const item of rawRules) {
    const record = asRecord(item);
    if (record === null || typeof record.id !== "string" || typeof record.description !== "string") {
      warnings.push(`法律证据规则条目缺少 id/description ${source}`);
      continue;
    }
    const evidenceTypeRaw = asString(record.evidence_type) ?? asString(record.evidenceType);
    if (evidenceTypeRaw === undefined) {
      warnings.push(`法律证据规则 ${record.id} 缺少 evidence_type，跳过`);
      continue;
    }
    if (!isKnownEvidenceType(evidenceTypeRaw)) {
      warnings.push(`法律证据规则 ${record.id} 未知证据类型 "${evidenceTypeRaw}"，跳过`);
      continue;
    }
    const check = asString(record.check);
    if (check === undefined) {
      warnings.push(`法律证据规则 ${record.id} 缺少 check，跳过`);
      continue;
    }
    const severityRaw = asString(record.severity) ?? "warning";
    const severity =
      severityRaw === "critical" || severityRaw === "warning" || severityRaw === "info" ? severityRaw : "warning";
    const legalBasis = asString(record.legalBasis);
    rules.push({
      id: record.id,
      description: record.description,
      evidenceType: evidenceTypeRaw,
      check,
      severity,
      ...(legalBasis !== undefined && legalBasis.trim() !== "" ? { legalBasis } : {}),
      ...(Array.isArray(record.conditions) ? { conditions: asStringArray(record.conditions) } : {}),
    });
  }
  return { ruleSet: { weights, rules }, warnings };
}
