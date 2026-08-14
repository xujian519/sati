/**
 * 首批合规单调 deny Guard（工具级强制约束）。
 *
 * 语义：Guard 是确定性硬约束——模型调用 evaluate_evidence 时，若输入
 * 违反《专利审查指南》第四部分第八章的证据形式要件（域外证据须公证认证、
 * 外文证据须附中文译本，EVI-011 系列规则），Guard 直接拒绝该次调用，
 * 不被任何 allow/ask 权限规则覆盖、不走 HITL 审批。
 *
 * 只做"明确缺失即拒绝"的确定性校验；模糊判断（证据真实性、证明力等）
 * 留在引擎与输出门禁，避免误伤。
 */

import type { ToolGuard } from "../../permission/guard/ToolGuard.js";
// 消费工具输入类型而非 ad-hoc cast：EvaluateEvidenceInput 字段改名时
// 编译期即报错（guard 依赖 evidenceType/notarized/legalized/translated），
// 避免合规路径静默失效（fail-open）。
import type { EvaluateEvidenceInput } from "../../tool/builtin/evaluateEvidence.js";
import { loadEvidenceRulesEngine } from "../evidence/rule-loader.js";

/** 适用工具名（与 createEvaluateEvidenceTool().name 的一致性由契约测试保证）。 */
export const EVIDENCE_COMPLIANCE_TOOL = "evaluate_evidence";

/** YAML 条件名 → guard 输入字段名（EVI-011 契约映射）。 */
const EVI_011_CONDITION_FIELDS = {
  evidence_notarized: "notarized",
  evidence_legalized: "legalized",
  evidence_translated: "translated",
} as const;

/**
 * 从 rule-loader 同一数据源派生 EVI-011 的强制条件字段；资产缺失时回退到
 * 硬编码集合，保证合规 guard 在无规则资产环境下仍可 fail-closed。
 */
export function evi011GuardConditionFields(): ReadonlySet<string> {
  const rule = loadEvidenceRulesEngine()
    .engine.getRules()
    .find(r => r.ruleId === "EVI-011");
  const derived: string[] = [];
  for (const condition of rule?.check?.conditions ?? []) {
    const field = EVI_011_CONDITION_FIELDS[condition as keyof typeof EVI_011_CONDITION_FIELDS];
    if (field !== undefined) derived.push(field);
  }
  return new Set(derived.length > 0 ? derived : ["notarized", "legalized", "translated"]);
}

/** 域外证据类型（需公证 + 认证）。 */
const OVERSEAS_EVIDENCE_TYPES = new Set(["overseas"]);

/** 外文证据类型（需附中文译本）。 */
const FOREIGN_LANGUAGE_TYPES = new Set(["foreign_language", "overseas"]);

/** 模块加载时从 rule-loader 派生一次 EVI-011 条件字段（缺资产时回退硬编码）。 */
const EVI_011_CONDITIONS = evi011GuardConditionFields();

function readEvidenceInput(input: unknown): EvaluateEvidenceInput | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return input as EvaluateEvidenceInput;
}

function isTrue(value: unknown): boolean {
  return value === true;
}

/**
 * 域外证据强制公证 + 认证（EVI-011）：evidenceType 为 overseas 时，
 * notarized 与 legalized 必须均为 true。
 */
export const overseasEvidenceNotarizationGuard: ToolGuard = (tool, input) => {
  if (tool.name !== EVIDENCE_COMPLIANCE_TOOL) return undefined;
  const evidence = readEvidenceInput(input);
  const evidenceType = evidence?.evidenceType;
  if (typeof evidenceType !== "string" || !OVERSEAS_EVIDENCE_TYPES.has(evidenceType)) return undefined;
  const missing = ["notarized", "legalized"].filter(
    field => EVI_011_CONDITIONS.has(field) && !isTrue((evidence as Record<string, unknown>)[field]),
  );
  if (missing.length > 0) {
    return {
      code: "EVI-011-notarization",
      message: `域外证据（evidenceType=${evidenceType}）必须声明已公证（notarized）且已认证（legalized），否则无法采信。`,
    };
  }
  return undefined;
};

/**
 * 外文证据强制附中文译本（EVI-011）：evidenceType 为 foreign_language /
 * overseas 时，translated 必须为 true。
 */
export const foreignEvidenceTranslationGuard: ToolGuard = (tool, input) => {
  if (tool.name !== EVIDENCE_COMPLIANCE_TOOL) return undefined;
  const evidence = readEvidenceInput(input);
  const evidenceType = evidence?.evidenceType;
  if (typeof evidenceType !== "string" || !FOREIGN_LANGUAGE_TYPES.has(evidenceType)) return undefined;
  if (EVI_011_CONDITIONS.has("translated") && !isTrue(evidence?.translated)) {
    return {
      code: "EVI-011-translation",
      message: `外文证据（evidenceType=${evidenceType}）必须附中文译本（translated=true），否则无法采信。`,
    };
  }
  return undefined;
};

/** 首批合规 guards 汇总（注册用）。 */
export const evidenceComplianceGuards: readonly ToolGuard[] = [
  overseasEvidenceNotarizationGuard,
  foreignEvidenceTranslationGuard,
];
