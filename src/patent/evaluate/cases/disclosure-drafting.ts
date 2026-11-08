/**
 * 起草质量 rubric（#830 M5）：五维 100 分制。
 *
 * 设计约束（T5.1）：
 * - 维度全覆盖：A26.3 充分公开 / A26.4 支持与清楚 / 结构完整性 / 反套话 / 权要布局；
 * - 权重合计 100（`DRAFTING_RUBRIC_TOTAL`）；
 * - 每个维度只读可观察产出（权项文本 + 说明书文本 + 可选金标特征），不读取其它维度
 *   分数，因此不存在维度间依赖环；
 * - 子图结论（enablement / claim_breadth）可选注入：有则 `signalSource: "graph"`，
 *   无则退到确定性代理信号并显式标记 `"deterministic"`——降级可见，不把"未跑子图"
 *   呈现成"子图已核验"。
 */

import { registerBuiltinAtoms, type StageProvider } from "../../atoms/index.js";
import { lintClaimText, parseClaim } from "../../claim-lint/index.js";
import {
  anchorClaimFeatures,
  buildClaimBreadthGraph,
  extractClaimBreadthResult,
  splitClaims,
} from "../../graph/domains/claim-breadth.js";
import {
  buildEnablementGraph,
  extractEnablementResult,
  runSpecPrechecks,
  SPEC_SECTIONS,
  splitSpecSections,
} from "../../graph/domains/enablement.js";
import { analyzeSlop } from "../../slop-engine.js";
import { runWorkflow } from "../../workflow.js";
import { patentDraftingManifest } from "../../workflow/manifests.js";
import type { StageExecutor } from "../../workflow/types.js";

const OPTIONAL_SPEC_SECTION = "摘要";

/** 五维定义与权重（合计 100）。 */
export type DraftingDimensionId = "enablement" | "claim_support_clarity" | "structure" | "anti_slop" | "claim_layout";

export type DraftingRubricDimension = {
  id: DraftingDimensionId;
  label: string;
  /** 分值权重；五个维度合计 100。 */
  weight: number;
  /** 该维度只读的可观察证据（不变量说明）。 */
  evidence: string;
};

export const DRAFTING_RUBRIC: readonly DraftingRubricDimension[] = [
  {
    id: "enablement",
    label: "A26.3 充分公开",
    weight: 30,
    evidence: "说明书章节/实施例/数值范围/效果定量性（子图结论可用时优先）",
  },
  {
    id: "claim_support_clarity",
    label: "A26.4 支持与清楚",
    weight: 25,
    evidence: "权项特征在说明书中的锚点命中率 + claim_lint errors（子图结论可用时优先）",
  },
  {
    id: "structure",
    label: "结构完整性",
    weight: 15,
    evidence: "六部分章节命中数 + 权项编号连续性 + 标题行",
  },
  {
    id: "anti_slop",
    label: "反套话",
    weight: 15,
    evidence: "slop-engine 43 分五维评分线性归一",
  },
  {
    id: "claim_layout",
    label: "权要布局",
    weight: 15,
    evidence: "独权数量 + 金标必要特征覆盖率 + 从权引用层级",
  },
];

export const DRAFTING_RUBRIC_TOTAL = DRAFTING_RUBRIC.reduce((sum, dimension) => sum + dimension.weight, 0);

const DIMENSION_BY_ID = new Map(DRAFTING_RUBRIC.map(dimension => [dimension.id, dimension]));

export type DraftingArtifacts = {
  claims: string;
  spec: string;
  /** 金标必要技术特征；缺省时布局覆盖率子项按满分记并在 reasons 留痕。 */
  requiredFeatures?: readonly string[];
};

/**
 * 子图结论（可选注入）；缺失时对应维度使用确定性代理信号。
 *
 * `source` 标注信号的**来源口径**（#847）：
 * - `live`：子图当场真实输出（`collectDraftingSignals` 跑 enablement / claim_breadth 图得出）。
 * - `recorded`：金标语料里**录制**的结论（`scripts/patent-golden-signals.ts` 按确定性
 *   规则生成，见 `docs/patent-drafting-eval.md`）——不是子图当场输出。
 *
 * 两者都是「确定性、可离线复现」的有效信号，**都可用于金标回归**；但来源不同，
 * 报告必须能区分，否则「录制的结论」会被误读成「子图真实结论」。
 */
export type DraftingSignals = {
  enablement?: { sufficientlyDisclosed?: boolean };
  claimBreadth?: { supportOk?: boolean; clarityOk?: boolean };
  /** 信号来源口径；缺省按 `live` 处理（调用方直接注入子图结论时无需显式声明）。 */
  source?: "live" | "recorded";
};

export type DraftingDimensionScore = {
  id: DraftingDimensionId;
  label: string;
  score: number;
  maxScore: number;
  /**
   * 维度结论的来源口径：
   * - `graph`：子图结论（`signals.source` 为 `live` 或未声明）；
   * - `recorded`：金标语料里**录制**的子图结论（`signals.source === "recorded"`）——
   *   有效信号、可用于回归，但**不是**子图当场输出；
   * - `deterministic`：确定性代理（未注入子图结论，报告中可见）。
   */
  signalSource: "graph" | "recorded" | "deterministic";
  reasons: string[];
};

export type DraftingRubricResult = {
  total: number;
  passLine: number;
  passed: boolean;
  dimensions: DraftingDimensionScore[];
  /** 使用确定性代理而非子图结论的维度（"未核验"与"已核验且无问题"可区分）。 */
  unverifiedDimensions: DraftingDimensionId[];
  /**
   * 结论来自**金标语料录制**的维度（#847）。
   *
   * 与 `unverifiedDimensions` 互斥：录制结论是有效结论、可用于回归，只是**不是**
   * 子图当场输出。单独列出，使报告能区分「录制的结论」与「子图真实结论」。
   */
  recordedDimensions: DraftingDimensionId[];
};

export type DraftingRubricOptions = {
  passLine?: number;
};

export const DEFAULT_DRAFTING_PASS_LINE = 80;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dimensionScore(
  id: DraftingDimensionId,
  score: number,
  signalSource: DraftingDimensionScore["signalSource"],
  reasons: string[],
): DraftingDimensionScore {
  const definition = DIMENSION_BY_ID.get(id);
  if (definition === undefined) throw new Error(`未知 rubric 维度：${id}`);
  return {
    id,
    label: definition.label,
    score: round2(Math.max(0, Math.min(definition.weight, score))),
    maxScore: definition.weight,
    signalSource,
    reasons,
  };
}

/** A26.3：子图结论优先；否则用说明书预检的确定性代理。 */
export function scoreEnablement(artifacts: DraftingArtifacts, signals?: DraftingSignals): DraftingDimensionScore {
  const graphVerdict = signals?.enablement?.sufficientlyDisclosed;
  if (typeof graphVerdict === "boolean") {
    const recorded = signals?.source === "recorded";
    return dimensionScore("enablement", graphVerdict ? 30 : 0, recorded ? "recorded" : "graph", [
      graphVerdict ? "enablement 子图判定：充分公开" : "enablement 子图判定：公开不充分",
      ...(recorded ? ["（金标语料录制的子图结论，非子图当场输出）"] : []),
    ]);
  }

  const reasons: string[] = ["未注入 enablement 子图结论，使用确定性预检代理"];
  const sections = splitSpecSections(artifacts.spec);
  const embodimentSection = sections["具体实施方式"] ?? "";
  const prechecks = runSpecPrechecks(artifacts.spec);
  let score = 0;

  if (embodimentSection.length >= 80) {
    score += 8;
    reasons.push("具体实施方式章节存在且篇幅充足");
  } else {
    reasons.push("具体实施方式缺失或篇幅不足");
  }
  if (prechecks.has_embodiment) {
    score += 8;
    reasons.push(`实施例计数 ${prechecks.embodiment_count}`);
  } else {
    reasons.push("未检测到实施例");
  }
  if (prechecks.numeric_range_endpoint_missing.length === 0) {
    score += 7;
  } else {
    reasons.push(`数值范围缺端点值：${prechecks.numeric_range_endpoint_missing.join("、")}`);
  }
  const vagueCount = prechecks.vague_effect_sentences.length;
  if (vagueCount === 0) {
    score += 4;
  } else if (vagueCount === 1) {
    score += 2;
    reasons.push("存在 1 句无定量数据的效果套话");
  } else {
    reasons.push(`存在 ${vagueCount} 句无定量数据的效果套话`);
  }
  if (artifacts.spec.trim().length >= 400) score += 3;
  else reasons.push("说明书全文过短（<400 字）");

  return dimensionScore("enablement", score, "deterministic", reasons);
}

/** A26.4：子图结论优先；否则 claim_lint errors + 特征锚点命中率代理。 */
export function scoreClaimSupportClarity(
  artifacts: DraftingArtifacts,
  signals?: DraftingSignals,
): DraftingDimensionScore {
  const supportVerdict = signals?.claimBreadth?.supportOk;
  const clarityVerdict = signals?.claimBreadth?.clarityOk;
  if (typeof supportVerdict === "boolean" && typeof clarityVerdict === "boolean") {
    const recorded = signals?.source === "recorded";
    return dimensionScore(
      "claim_support_clarity",
      (supportVerdict ? 13 : 0) + (clarityVerdict ? 12 : 0),
      recorded ? "recorded" : "graph",
      [
        supportVerdict ? "claim_breadth 子图判定：以说明书为依据" : "claim_breadth 子图判定：缺乏说明书依据",
        clarityVerdict ? "claim_breadth 子图判定：权项清楚" : "claim_breadth 子图判定：权项不清楚",
        ...(recorded ? ["（金标语料录制的子图结论，非子图当场输出）"] : []),
      ],
    );
  }

  const reasons: string[] = ["未注入 claim_breadth 子图结论，使用确定性代理"];
  const lint = lintClaimText(artifacts.claims);
  const clarityScore = lint.errors.length === 0 ? 12 : Math.max(0, 12 - lint.errors.length * 4);
  if (lint.errors.length > 0) {
    reasons.push(`claim_lint errors ${lint.errors.length} 处：${lint.errors.map(issue => issue.rule).join("、")}`);
  } else {
    reasons.push("claim_lint 无 error");
  }

  const anchored = anchorClaimFeatures(artifacts.claims, artifacts.spec);
  const featureTotal = anchored.matched + anchored.unmatched;
  const ratio = featureTotal === 0 ? 0 : anchored.matched / featureTotal;
  reasons.push(`权项特征锚点命中 ${anchored.matched}/${featureTotal}`);
  return dimensionScore("claim_support_clarity", clarityScore + 13 * ratio, "deterministic", reasons);
}

/** 结构完整性：六部分章节 + 权项编号连续性 + 标题行。 */
export function scoreStructure(artifacts: DraftingArtifacts): DraftingDimensionScore {
  const reasons: string[] = [];
  const sections = splitSpecSections(artifacts.spec);
  const required = [...SPEC_SECTIONS, OPTIONAL_SPEC_SECTION];
  const present = required.filter(section => sections[section] !== undefined);
  const structureScore = 8 * (present.length / required.length);
  reasons.push(`章节命中 ${present.length}/${required.length}`);
  if (present.length < required.length) {
    reasons.push(`缺失：${required.filter(section => !present.includes(section)).join("、")}`);
  }

  const numberingIssues = lintClaimText(artifacts.claims).issues.filter(issue => issue.rule === "numbering-continuity");
  const numberingScore = numberingIssues.length === 0 ? 4 : 0;
  if (numberingIssues.length > 0) reasons.push("权项编号不连续");

  const titleLine =
    artifacts.spec
      .split("\n")
      .find(line => line.trim().length > 0)
      ?.trim() ?? "";
  const titleScore = /^(?:一种|用于|基于|包含|本发明)/.test(titleLine) ? 3 : 0;
  if (titleScore === 0) reasons.push("说明书缺少标题行");

  return dimensionScore("structure", structureScore + numberingScore + titleScore, "deterministic", reasons);
}

/** 反套话：slop-engine 43 分制线性归一到 15 分（只评说明书，避免权项行数挤占首段判定）。 */
export function scoreAntiSlop(artifacts: DraftingArtifacts): DraftingDimensionScore {
  const analysis = analyzeSlop(artifacts.spec);
  const { directness, evidence, rhythm, practicality, concision, total } = analysis.score;
  return dimensionScore("anti_slop", (total / 43) * 15, "deterministic", [
    `slop ${total}/43（直接性 ${directness} / 证据性 ${evidence} / 节奏 ${rhythm} / 务实性 ${practicality} / 简洁性 ${concision}）`,
  ]);
}

/** 权要布局：独权数量 + 必要特征覆盖率 + 从权引用层级。 */
export function scoreClaimLayout(artifacts: DraftingArtifacts): DraftingDimensionScore {
  const reasons: string[] = [];
  const parsed = splitClaims(artifacts.claims).map(claim => parseClaim(claim.text, claim.claimNo));
  const independents = parsed.filter(claim => claim.independent);
  const dependents = parsed.filter(claim => !claim.independent);

  const independentScore = independents.length === 1 ? 5 : independents.length > 1 ? 3 : 0;
  reasons.push(`独立权利要求 ${independents.length} 项`);
  if (independents.length > 1) reasons.push("存在多项独权（布局分散）");
  if (independents.length === 0) reasons.push("缺少独立权利要求");

  const requiredFeatures = artifacts.requiredFeatures ?? [];
  const independentText = independents.map(claim => claim.text).join("\n");
  let coverageScore = 5;
  if (requiredFeatures.length === 0) {
    reasons.push("未提供金标必要特征，覆盖率子项按满分记");
  } else {
    const hit = requiredFeatures.filter(feature => independentText.includes(feature)).length;
    const ratio = hit / requiredFeatures.length;
    coverageScore = 5 * ratio;
    reasons.push(`独权必要特征覆盖 ${hit}/${requiredFeatures.length}`);
  }

  const invalidReferences = dependents.filter(
    claim => claim.dependsOn.length === 0 || claim.dependsOn.some(ref => ref < 1 || ref >= claim.claimNo),
  );
  const dependentScore = dependents.length === 0 ? 0 : invalidReferences.length === 0 ? 5 : 2;
  if (dependents.length === 0) reasons.push("缺少从属权利要求");
  else if (invalidReferences.length > 0) reasons.push(`从权引用关系异常 ${invalidReferences.length} 项`);

  return dimensionScore("claim_layout", independentScore + coverageScore + dependentScore, "deterministic", reasons);
}

/** 汇总五维分数；纯函数，同输入同输出。 */
export function scoreDraftingArtifacts(
  artifacts: DraftingArtifacts,
  signals?: DraftingSignals,
  options: DraftingRubricOptions = {},
): DraftingRubricResult {
  const passLine = options.passLine ?? DEFAULT_DRAFTING_PASS_LINE;
  const dimensions = [
    scoreEnablement(artifacts, signals),
    scoreClaimSupportClarity(artifacts, signals),
    scoreStructure(artifacts),
    scoreAntiSlop(artifacts),
    scoreClaimLayout(artifacts),
  ];
  const total = round2(dimensions.reduce((sum, dimension) => sum + dimension.score, 0));
  return {
    total,
    passLine,
    passed: total >= passLine,
    dimensions,
    unverifiedDimensions: dimensions
      .filter(dimension => dimension.signalSource === "deterministic")
      .map(dimension => dimension.id),
    recordedDimensions: dimensions
      .filter(dimension => dimension.signalSource === "recorded")
      .map(dimension => dimension.id),
  };
}

// ---------------------------------------------------------------------------
// 金标语料与批量报告
// ---------------------------------------------------------------------------

export type DraftingGoldenCase = {
  id: string;
  class: "clean" | "defect";
  disclosure: string;
  claims: string;
  spec: string;
  requiredFeatures?: string[];
  /** defect 用例声明的期望失分维度；用于校验缺陷确实落在该维度上。 */
  expectedFailures?: DraftingDimensionId[];
  signals?: DraftingSignals;
};

export type DraftingCaseOutcome = {
  id: string;
  class: DraftingGoldenCase["class"];
  total: number;
  passed: boolean;
  expectedFailures: DraftingDimensionId[];
  /** 期望失分维度中确实未拿满分的集合。 */
  detectedFailures: DraftingDimensionId[];
  unverifiedDimensions: DraftingDimensionId[];
  /** 结论来自金标语料**录制**信号的维度（#847；与 unverifiedDimensions 互斥）。 */
  recordedDimensions: DraftingDimensionId[];
  result: DraftingRubricResult;
};

export type DraftingBatchReport = {
  passLine: number;
  count: number;
  clean: { count: number; passed: number; passRate: number; mean: number };
  defect: { count: number; detected: number; detectionRate: number; mean: number };
  /** 全批次使用确定性代理的维度并集（未跑子图，报告中可见）。 */
  unverifiedDimensions: DraftingDimensionId[];
  /**
   * 全批次结论来自**录制**信号的维度并集（#847）。
   *
   * 金标回归的 signals 是录制的子图结论（确定性规则生成），**不是**子图当场
   * 输出——当场输出口径走 `--live`。单独列出，使两套口径在报告中不互相冒充。
   */
  recordedDimensions: DraftingDimensionId[];
  cases: DraftingCaseOutcome[];
};

const DIMENSION_IDS = new Set<string>(DRAFTING_RUBRIC.map(dimension => dimension.id));

/** 解析金标语料（JSONL，外部输入边界；字段缺失/类型错误显式报行号）。 */
export function parseDraftingGoldenJsonl(text: string, source = "<jsonl>"): DraftingGoldenCase[] {
  const cases: DraftingGoldenCase[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? "";
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 解析失败必须指名行号：否则坏行会被当成"没有用例"而静默降低覆盖面。
      throw new Error(`${source}:${index + 1} 不是合法 JSON`);
    }
    cases.push(normalizeGoldenCase(parsed, `${source}:${index + 1}`));
  }
  return cases;
}

function normalizeGoldenCase(value: unknown, where: string): DraftingGoldenCase {
  if (typeof value !== "object" || value === null) throw new Error(`${where} 不是对象`);
  const record = value as Record<string, unknown>;
  const id = requireString(record, "id", where);
  const klass = requireString(record, "class", where);
  if (klass !== "clean" && klass !== "defect") throw new Error(`${where} class 必须是 clean/defect`);
  const requiredFeatures = optionalStringArray(record, "requiredFeatures", where);
  const expectedFailures = optionalStringArray(record, "expectedFailures", where);
  for (const dimension of expectedFailures) {
    if (!DIMENSION_IDS.has(dimension)) throw new Error(`${where} 未知期望失分维度：${dimension}`);
  }
  const signals = normalizeGoldenSignals(record.signals, where);
  return {
    id,
    class: klass,
    disclosure: requireString(record, "disclosure", where),
    claims: requireString(record, "claims", where),
    spec: requireString(record, "spec", where),
    ...(requiredFeatures.length > 0 ? { requiredFeatures } : {}),
    ...(expectedFailures.length > 0 ? { expectedFailures: expectedFailures as DraftingDimensionId[] } : {}),
    // 子图结论透传（R1）：此前丢弃 signals 导致金标路径的 A26.4 维度恒为
    // "确定性代理"（unverified），子图结论永远进不了金标回归。
    ...(signals !== undefined ? { signals } : {}),
  };
}

/**
 * 解析金标内的子图结论（可选）。
 *
 * 只接受布尔字段；非布尔值直接报错而非静默丢弃——避免"写了但没生效"的
 * 假核验（金标带坏信号却按"未核验"跑，结论会误导）。
 */
function normalizeGoldenSignals(value: unknown, where: string): DraftingSignals | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} signals 必须是对象`);
  }
  const record = value as Record<string, unknown>;
  const signals: DraftingSignals = {};
  const enablement = record.enablement;
  if (enablement !== undefined) {
    if (typeof enablement !== "object" || enablement === null || Array.isArray(enablement)) {
      throw new Error(`${where} signals.enablement 必须是对象`);
    }
    const sufficientlyDisclosed = (enablement as Record<string, unknown>).sufficientlyDisclosed;
    if (sufficientlyDisclosed !== undefined) {
      if (typeof sufficientlyDisclosed !== "boolean") {
        throw new Error(`${where} signals.enablement.sufficientlyDisclosed 必须是布尔值`);
      }
      signals.enablement = { sufficientlyDisclosed };
    }
  }
  const claimBreadth = record.claimBreadth;
  if (claimBreadth !== undefined) {
    if (typeof claimBreadth !== "object" || claimBreadth === null || Array.isArray(claimBreadth)) {
      throw new Error(`${where} signals.claimBreadth 必须是对象`);
    }
    const breadthRecord = claimBreadth as Record<string, unknown>;
    const supportOk = breadthRecord.supportOk;
    const clarityOk = breadthRecord.clarityOk;
    if (supportOk !== undefined && typeof supportOk !== "boolean") {
      throw new Error(`${where} signals.claimBreadth.supportOk 必须是布尔值`);
    }
    if (clarityOk !== undefined && typeof clarityOk !== "boolean") {
      throw new Error(`${where} signals.claimBreadth.clarityOk 必须是布尔值`);
    }
    signals.claimBreadth = {
      ...(supportOk !== undefined ? { supportOk: supportOk as boolean } : {}),
      ...(clarityOk !== undefined ? { clarityOk: clarityOk as boolean } : {}),
    };
  }
  // 来源口径（#847）：金标语料里的 signals 一律是「录制」的子图结论
  // （由 scripts/patent-golden-signals.ts 按确定性规则生成），不是子图当场输出。
  // 显式校验——写错就报错，避免语料层的来源标注与事实不符。
  const source = record.source;
  if (source !== undefined && source !== "recorded" && source !== "live") {
    throw new Error(`${where} signals.source 必须是 "recorded" | "live"`);
  }
  if (source !== undefined) {
    signals.source = source;
  }
  return signals;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${where} 缺少非空字符串字段 ${key}`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string, where: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${where} 字段 ${key} 必须是字符串数组`);
  }
  return value as string[];
}

/** 批量评分（确定性；不发模型请求）。 */
export function evaluateDraftingGolden(
  cases: readonly DraftingGoldenCase[],
  options: DraftingRubricOptions = {},
): DraftingBatchReport {
  const passLine = options.passLine ?? DEFAULT_DRAFTING_PASS_LINE;
  const outcomes = cases.map(item => {
    const result = scoreDraftingArtifacts(
      { claims: item.claims, spec: item.spec, requiredFeatures: item.requiredFeatures ?? [] },
      item.signals,
      { passLine },
    );
    const expectedFailures = item.expectedFailures ?? [];
    const detectedFailures = expectedFailures.filter(dimension => {
      const scored = result.dimensions.find(entry => entry.id === dimension);
      return scored !== undefined && scored.score < scored.maxScore;
    });
    return {
      id: item.id,
      class: item.class,
      total: result.total,
      passed: result.passed,
      expectedFailures,
      detectedFailures,
      unverifiedDimensions: result.unverifiedDimensions,
      recordedDimensions: result.recordedDimensions,
      result,
    };
  });

  const cleanCases = outcomes.filter(item => item.class === "clean");
  const defectCases = outcomes.filter(item => item.class === "defect");
  const cleanPassed = cleanCases.filter(item => item.passed).length;
  const defectDetected = defectCases.filter(
    item => item.expectedFailures.length > 0 && item.detectedFailures.length === item.expectedFailures.length,
  ).length;
  const unverified = new Set<DraftingDimensionId>();
  for (const item of outcomes) {
    for (const dimension of item.unverifiedDimensions) unverified.add(dimension);
  }
  const recorded = new Set<DraftingDimensionId>();
  for (const item of outcomes) {
    for (const dimension of item.recordedDimensions) recorded.add(dimension);
  }

  return {
    passLine,
    count: outcomes.length,
    clean: {
      count: cleanCases.length,
      passed: cleanPassed,
      passRate: cleanCases.length === 0 ? 0 : round2(cleanPassed / cleanCases.length),
      mean: cleanCases.length === 0 ? 0 : round2(mean(cleanCases.map(item => item.total))),
    },
    defect: {
      count: defectCases.length,
      detected: defectDetected,
      detectionRate: defectCases.length === 0 ? 0 : round2(defectDetected / defectCases.length),
      mean: defectCases.length === 0 ? 0 : round2(mean(defectCases.map(item => item.total))),
    },
    unverifiedDimensions: [...unverified],
    recordedDimensions: [...recorded],
    cases: outcomes,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

// ---------------------------------------------------------------------------
// 起草管线（T5.2）：真实 provider / mock provider 均可，不需要 API key
// ---------------------------------------------------------------------------

export type DraftingPipelineOptions = {
  provider?: StageProvider;
  executor?: StageExecutor;
};

export type DraftingPipelineRun = {
  claims: string;
  spec: string;
  /** 管线降级阶段（来自 runWorkflow；空数组 = 全部阶段按预期执行）。 */
  degradedSteps: string[];
};

/** 跑完整 patent_drafting_v1 管线并取出权项/说明书产物；缺任一产物即显式失败。 */
export async function runDraftingPipeline(
  disclosure: string,
  options: DraftingPipelineOptions = {},
): Promise<DraftingPipelineRun> {
  // 注册幂等：宿主未注册时也能直接调用，已注册时同名覆盖。
  registerBuiltinAtoms();
  // 评测场景把所有 HITL 决策门自动放行（clarity_gate / deconstruct_approval /
  // review_gate / figure_gate / final_approval）；否则管线会在第一个决策门暂停，
  // 拿不到完整产物。放行只跳过人工确认，不跳过阶段本身的确定性校验。
  const approvalGrants = patentDraftingManifest.stages.map(stage => stage.id);
  const result = await runWorkflow(
    patentDraftingManifest,
    { text: disclosure, source_text: disclosure },
    options.executor ?? (async () => "（评测：未提供阶段执行器）"),
    {
      approvalGrants,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
    },
  );
  const claims = stageOutput(result.stages, "draft_claims");
  const spec = stageOutput(result.stages, "draft_spec");
  if (claims.length === 0 || spec.length === 0) {
    const missing = [claims.length === 0 ? "权利要求" : "", spec.length === 0 ? "说明书" : ""]
      .filter(Boolean)
      .join("与");
    throw new Error(
      `起草管线未产出${missing}（completed=${String(result.completed)}，degraded=${result.degradedSteps.join("、") || "无"}）`,
    );
  }
  return { claims, spec, degradedSteps: result.degradedSteps };
}

function stageOutput(stages: readonly { stageId: string; output: string }[], stageId: string): string {
  return stages.find(stage => stage.stageId === stageId)?.output ?? "";
}

/** 跑 enablement / claim-breadth 子图取得 rubric 信号（需要 provider 才能拿到 LLM 结论）。 */
export async function collectDraftingSignals(
  artifacts: { claims: string; spec: string },
  options: { provider?: StageProvider } = {},
): Promise<DraftingSignals> {
  registerBuiltinAtoms();
  const runOptions = options.provider !== undefined ? { provider: options.provider } : {};
  const enablementGraph = buildEnablementGraph().compile("load");
  const enablementRun = await enablementGraph.run({ text: artifacts.spec }, runOptions);
  const claimBreadthGraph = buildClaimBreadthGraph().compile("load");
  const claimBreadthRun = await claimBreadthGraph.run(
    { claim_text: artifacts.claims, spec: artifacts.spec },
    runOptions,
  );
  const breadth = extractClaimBreadthResult(claimBreadthRun.state);
  return {
    enablement: extractEnablementResult(enablementRun.state),
    claimBreadth: { supportOk: breadth.supportOk, clarityOk: breadth.clarityOk },
  };
}
