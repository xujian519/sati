/**
 * src/patent/evaluate — 多模型共识判定与 Verdict Envelope（typed verdict 审计）。
 *
 * 对齐 Ouroboros 的"评估门三级化（机械 → 语义 → 共识）"与 verdict envelope
 * （结论类型化、可审计、不可镜像化）：
 * - 机械层：确定性检查器（RuleGate/quality-gate/slop-gate/validateDraftSpec）
 * - 语义层：LLM Rubric Judge 单模型采样（见 ./llm-judge.ts collectJudgeVotes）
 * - 共识层：多 judge（不同 modelHint/provider）投票 → 中位数 + 离散度 →
 *   分歧检测（spread 超限标 disagree，结果尾部附"需人工复核"审计标记，
 *   不静默取中位；属输出面提示，不自动触发 HITL 中断）
 * - VerdictEnvelope：三层结果封装为不可变审计对象（参与者/时间/内容哈希），
 *   verifyVerdictEnvelope 重算哈希以检出篡改或镜像化（"impossible to game"）。
 *
 * 判定语义（保守序）：机械层 blocked 优先于一切；共识 disagree 次之；
 * 其余按 median 与阈值。
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 共识判定
// ---------------------------------------------------------------------------

export type JudgeVote = {
  /** 判定者标识（如 "judge:a" / "judge:b" / "default"）。 */
  judgeId: string;
  /** 参与者 provider（审计）。 */
  provider?: string;
  /** 参与者 model（审计）。 */
  model?: string;
  /** 0-1 评分。 */
  score: number;
  /** 评分理由（可空）。 */
  rationale?: string;
};

export type ConsensusVerdict =
  | { verdict: "pass"; median: number; spread: number; votes: JudgeVote[]; threshold: number; note?: string }
  | { verdict: "needs_revision"; median: number; spread: number; votes: JudgeVote[]; threshold: number; note?: string }
  | {
      verdict: "disagree";
      median: number;
      spread: number;
      votes: JudgeVote[];
      threshold: number;
      note: string;
    };

export type ConsensusOptions = {
  /** 通过线（缺省 0.7，对齐 patent_eval PASS_LINE）。 */
  threshold?: number;
  /** 分歧阈值：投票极差超过该值即判 disagree（缺省 0.25）。 */
  spreadLimit?: number;
};

/** 共识判定（纯函数）：votes 为空返回 undefined；单票 spread=0 直接按阈值判。 */
export function resolveConsensus(
  votes: readonly JudgeVote[],
  options: ConsensusOptions = {},
): ConsensusVerdict | undefined {
  if (votes.length === 0) return undefined;
  const threshold = options.threshold ?? 0.7;
  const spreadLimit = options.spreadLimit ?? 0.25;
  const sorted = votes.map(v => v.score).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // 偶数票取中间两值平均（与 llm-judge median 同约定），奇数取中位。
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const spread = round2(sorted[sorted.length - 1]! - sorted[0]!);
  const votesCopy = [...votes];
  const note = spread > spreadLimit ? `投票分歧（极差 ${spread.toFixed(2)} > ${spreadLimit}），需人工复核` : undefined;
  if (note !== undefined) {
    return { verdict: "disagree", median, spread, votes: votesCopy, threshold, note };
  }
  if (median >= threshold) return { verdict: "pass", median, spread, votes: votesCopy, threshold };
  return { verdict: "needs_revision", median, spread, votes: votesCopy, threshold };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Verdict Envelope —— typed verdict 审计对象
// ---------------------------------------------------------------------------

export type VerdictLayer = {
  layer: "mechanical" | "semantic" | "consensus";
  label: string;
  /** 该层原始判级/结果（机械:pass/needs_revision/blocked；语义:分数区间；共识:判定）。 */
  verdict: string;
  /** 展示摘要（≤ 400 字，供审计页）。 */
  detail: string;
  /** 参与者（规则 id / judge:model 组合）。 */
  participants: string[];
  /** 层评估时间（ISO）。 */
  at: string;
};

export type VerdictEnvelope = {
  /** 被评估对象摘要（前 120 字）。 */
  artifact: string;
  /** 产物类型（如 "graph:inventiveness/conclusion"）。 */
  artifactType: string;
  /** 三层（固定顺序：mechanical → semantic → consensus）。 */
  layers: VerdictLayer[];
  /** 合成判定（保守序：blocked > disagree > needs_revision > pass）。 */
  overall: string;
  /** 内容哈希（sha256，覆盖 artifact + layers + overall 稳定序列化；篡改即失配）。 */
  hash: string;
  createdAt: string;
};

/** 合成判定（保守序）：机械 blocked 优先，其次共识 disagree，再按语义层次。 */
export function compositeOverall(layers: readonly VerdictLayer[]): string {
  const byLayer = new Map(layers.map(l => [l.layer, l.verdict.toLowerCase()]));
  const mechanical = byLayer.get("mechanical");
  const consensus = byLayer.get("consensus");
  if (mechanical === "blocked") return "blocked";
  if (consensus === "disagree") return "disagree";
  if (mechanical === "needs_revision" || consensus === "needs_revision") return "needs_revision";
  if (mechanical === "pass" || consensus === "pass") return "pass";
  return "unknown";
}

/** 稳定序列化层（构造与校验共用的唯一序列化路径；overall 一并封印）。 */
function serializeEnvelopeCore(env: Pick<VerdictEnvelope, "artifact" | "artifactType" | "layers" | "overall">): string {
  return JSON.stringify({
    artifact: env.artifact,
    artifactType: env.artifactType,
    layers: env.layers,
    overall: env.overall,
  });
}

/** 构造 Verdict Envelope（计算内容哈希，overall 纳入封印；层顺序强制 mechanical→semantic→consensus）。 */
export function buildVerdictEnvelope(input: {
  artifact: string;
  artifactType: string;
  layers: VerdictLayer[];
  now?: () => string;
}): VerdictEnvelope {
  const order: Record<VerdictLayer["layer"], number> = { mechanical: 0, semantic: 1, consensus: 2 };
  const layers = [...input.layers].sort((a, b) => order[a.layer] - order[b.layer]);
  const createdAt = input.now?.() ?? new Date().toISOString();
  const overall = compositeOverall(layers);
  const core = { artifact: input.artifact, artifactType: input.artifactType, layers, overall };
  return {
    ...core,
    hash: createHash("sha256").update(serializeEnvelopeCore(core)).digest("hex"),
    createdAt,
  };
}

/**
 * 校验 envelope 内容哈希与 overall 一致性（检出篡改/镜像化：任何字段/判级变化 → 失配 false）。
 * 预留离线审计 API：生产图模式只 build + 打印 hash（patentWorkflowRunTool），本函数当前
 * 仅测试消费——宿主落盘审计页/复核工具接线前不参与运行时判定。
 */
export function verifyVerdictEnvelope(envelope: VerdictEnvelope): boolean {
  // 重推导 overall（保守序）并断言与存储值一致：仅篡改 overall 判级而不动 layers
  // 时，即使重算哈希也无法通过——overall 必须可被 layers 唯一推导（不可镜像化）。
  const recomputed = compositeOverall(envelope.layers);
  const core = {
    artifact: envelope.artifact,
    artifactType: envelope.artifactType,
    layers: envelope.layers,
    overall: recomputed,
  };
  const expected = createHash("sha256").update(serializeEnvelopeCore(core)).digest("hex");
  return recomputed === envelope.overall && expected === envelope.hash;
}

/** 渲染共识判定为可读文本（工具结果附加段）。 */
export function renderConsensusText(verdict: ConsensusVerdict): string {
  const votes = verdict.votes
    .map(
      v =>
        `  - ${v.judgeId}${v.model !== undefined ? ` (${v.model})` : ""}: ${v.score.toFixed(3)}${v.rationale ? ` — ${v.rationale.slice(0, 60)}` : ""}`,
    )
    .join("\n");
  const label =
    verdict.verdict === "pass"
      ? "✅ 通过"
      : verdict.verdict === "needs_revision"
        ? "⚠️ 需修订"
        : "🤔 分歧（需人工复核）";
  return `🧭 共识判定: ${label} | 中位 ${verdict.median.toFixed(3)}（阈值 ${verdict.threshold}）| 极差 ${verdict.spread.toFixed(3)}\n${votes}${verdict.note !== undefined ? `\n${verdict.note}` : ""}`;
}
