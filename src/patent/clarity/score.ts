/**
 * src/patent/clarity — 交底书清晰度评分与门判定（纯函数，零 IO）。
 *
 * 融合模型（对齐 Ouroboros Ambiguity = 1 - Σ(clarity_i × weight_i)）：
 *   维度总分 clarity_i = 0.75 × semantic_i + 0.25 × signal_i
 *   （semantic 为 LLM 语义打分 0-1；signal 为机械结构信号 0/1——机械层
 *     免费兜底：LLM 对缺失信号的视而不见无法把分抬过 0.8）
 *   总清晰度 clarity = Σ clarity_i × weight_i
 *   模糊度 ambiguity = 1 - clarity
 *   门：ambiguity ≤ 0.2（= 清晰度 ≥ 0.8）方可进入解构/提取。
 *
 * 阈值与权重均为"可争论的默认值"（Ouroboros 同款立场）：低于门槛不硬锁，
 * 由 ClarityGateHandler 挂 HITL 决策（确认继续/补充/退回）。
 */

export type ClarityDimensionKey = "problem" | "solution" | "effect" | "enablement";

export type ClarityDimension = {
  key: ClarityDimensionKey;
  label: string;
  weight: number;
  /** 语义分（LLM，0-1）；semanticOnly 模式（无 LLM）时等于信号分。 */
  semantic: number;
  /** 机械信号（0/1）。 */
  signal: 0 | 1;
  /** 融合分（clarity_i）。 */
  score: number;
  /** 语义层理由（可空——LLM 未提供时不展示）。 */
  reason?: string;
};

export type ClarityScore = {
  dimensions: ClarityDimension[];
  /** 总清晰度 0-1。 */
  clarity: number;
  /** 模糊度 0-1（= 1 - clarity）。 */
  ambiguity: number;
  /** 门判定（ambiguity ≤ 阈值）。 */
  passed: boolean;
  /** 各维度最低分项（供报告"第一步改进什么"指引）。 */
  weakest: ClarityDimension;
  /** 是否仅机械层（semanticOnly：LLM 不可用降级路径）。 */
  semanticOnly: boolean;
};

/** 维度权重（专利交底书：方案完整 > 问题清晰 ≈ 效果可测 > 实施充分）。 */
export const CLARITY_DIMENSIONS: ReadonlyArray<Omit<ClarityDimension, "semantic" | "signal" | "score">> = [
  { key: "problem", label: "技术问题清晰", weight: 0.25 },
  { key: "solution", label: "技术方案清晰", weight: 0.3 },
  { key: "effect", label: "技术效果可测", weight: 0.25 },
  { key: "enablement", label: "实施充分", weight: 0.2 },
];

/** 模糊度门槛（透明默认值；低于 0.8 清晰度的交底书进入解构即返工源头）。 */
export const CLARITY_THRESHOLD = 0.2;

/** 语义分/信号分占比（机械信号占 25%，是不可绕过的审计底）。 */
export const SIGNAL_WEIGHT = 0.25;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 综合评分：语义分（四维 0-1）与机械信号融合，输出维度明细 + 模糊度 + 门判定。
 * semantic 缺省 undefined → semanticOnly 模式（clarity_i = signal_i，仅机械层）。
 */
export function computeClarityScore(
  semantic: Partial<Record<ClarityDimensionKey, number>> | undefined,
  signals: ReadonlyArray<{ key: ClarityDimensionKey; present: boolean }>,
  reasons: Partial<Record<ClarityDimensionKey, string>> = {},
): ClarityScore {
  const semanticOnly = semantic === undefined;
  const dimensions: ClarityDimension[] = CLARITY_DIMENSIONS.map(def => {
    const signal = signals.find(s => s.key === def.key)?.present ? 1 : 0;
    const semanticValue = semanticOnly ? signal : clamp01(semantic[def.key] ?? signal);
    const fused = round2(semanticOnly ? signal : semanticValue * (1 - SIGNAL_WEIGHT) + signal * SIGNAL_WEIGHT);
    return {
      ...def,
      semantic: round2(semanticValue),
      signal,
      score: fused,
      ...(reasons[def.key] !== undefined ? { reason: reasons[def.key] } : {}),
    };
  });
  const clarity = round2(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0));
  const ambiguity = round2(1 - clarity);
  const weakest = dimensions.reduce((min, d) => (d.score < min.score ? d : min), dimensions[0]!);
  return {
    dimensions,
    clarity,
    ambiguity,
    passed: ambiguity <= CLARITY_THRESHOLD,
    weakest,
    semanticOnly,
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 渲染机械信号为语义层 prompt 的上下文证据块（含证据句与缺失提示）。 */
export function formatSignalsForPrompt(
  signals: ReadonlyArray<{ key: string; present: boolean; evidence?: string[]; missingHint?: string }>,
): string {
  return signals
    .map(s => {
      const label = CLARITY_DIMENSIONS.find(d => d.key === s.key)?.label ?? s.key;
      if (s.present) {
        const ev = (s.evidence ?? []).map(e => `    - ${e}`).join("\n");
        return `[${label}] 存在结构信号：\n${ev}`;
      }
      return `[${label}] 未检测到结构信号（${s.missingHint ?? "缺少该维度表述"}）`;
    })
    .join("\n");
}
