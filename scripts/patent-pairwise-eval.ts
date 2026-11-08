/**
 * 专利撰写 pairwise 校准（#830 M7）。
 *
 * 输入 JSONL，每行：
 *   { id: string, score_a: number, score_b: number, preference: "a" | "b" | "equal" }
 * `score_*` 为模型 rubric 分数，`preference` 为代理师人工偏好。
 *
 * 计算 Kendall τ-b，并与人工偏好并列输出不一致项。
 * 按计划，τ < 0.4 只报告、不 fail（退出码恒为 0），避免评测数据不足时阻断 CI。
 */

import fs from "node:fs";
import path from "node:path";

export type Preference = "a" | "b" | "equal";

export interface PairwiseItem {
  id: string;
  score_a: number;
  score_b: number;
  preference: Preference;
}

export interface TauReport {
  tau: number;
  concordant: number;
  discordant: number;
  tiesModel: number;
  tiesHuman: number;
  pairCount: number;
  /** τ 的近似 95% 置信区间（正态近似；样本量小时区间很宽，仅作参考）。 */
  confidenceInterval?: { lower: number; upper: number };
  disagreements: Array<{ id: string; model: string; human: Preference }>;
}

/**
 * τ-b 的近似标准误（正态近似）。
 *
 * 口径：SE ≈ sqrt((1 - τ²) / (n(n-1) / 2))——近似忽略 tie 修正，
 * 样本量小时区间会很宽，只作参考，不作达标依据（达标仍看 τ 阈值）。
 */
function tauStandardError(tau: number, pairs: number): number | undefined {
  if (pairs < 1) return undefined;
  const variance = (1 - tau * tau) / pairs;
  // τ = ±1 时方差为 0 → SE 为 0，区间退化为 [τ, τ]（仍给出，避免"无区间"歧义）。
  if (variance < 0) return undefined;
  return Math.sqrt(variance);
}

function sign(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/** Kendall τ-b（含 tied 处理）。样本不足 2 或分母为 0 时返回 0。 */
export function kendallTauB(items: readonly PairwiseItem[]): TauReport {
  const n = items.length;
  const modelRank = items.map(item => sign(item.score_a - item.score_b));
  const humanRank = items.map(item => {
    if (item.preference === "a") return 1;
    if (item.preference === "b") return -1;
    return 0;
  });

  let concordant = 0;
  let discordant = 0;
  let tiesModel = 0;
  let tiesHuman = 0;
  const disagreements: TauReport["disagreements"] = [];

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const modelDelta = modelRank[i]! - modelRank[j]!;
      const humanDelta = humanRank[i]! - humanRank[j]!;
      const modelTie = modelDelta === 0;
      const humanTie = humanDelta === 0;
      if (modelTie) tiesModel += 1;
      if (humanTie) tiesHuman += 1;
      if (modelTie || humanTie) continue;
      if (sign(modelDelta) === sign(humanDelta)) concordant += 1;
      else discordant += 1;
    }
  }

  for (const item of items) {
    const model = sign(item.score_a - item.score_b);
    const modelLabel = model > 0 ? "a" : model < 0 ? "b" : "equal";
    if (modelLabel !== item.preference) {
      disagreements.push({ id: item.id, model: modelLabel, human: item.preference });
    }
  }

  const pairs = (n * (n - 1)) / 2;
  const denominator = Math.sqrt((pairs - tiesModel) * (pairs - tiesHuman));
  const tau = denominator === 0 ? 0 : (concordant - discordant) / denominator;
  const se = tauStandardError(tau, pairs);
  const confidenceInterval =
    se === undefined ? undefined : { lower: Math.max(-1, tau - 1.96 * se), upper: Math.min(1, tau + 1.96 * se) };
  return {
    tau,
    concordant,
    discordant,
    tiesModel,
    tiesHuman,
    pairCount: pairs,
    ...(confidenceInterval !== undefined ? { confidenceInterval } : {}),
    disagreements,
  };
}

export function loadPairwiseJsonl(filePath: string): PairwiseItem[] {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  return lines.map((line, index) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const id = typeof parsed.id === "string" ? parsed.id : `line-${index + 1}`;
    const scoreA = Number(parsed.score_a);
    const scoreB = Number(parsed.score_b);
    const preference = parsed.preference;
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) {
      throw new Error(`${id}: score_a/score_b must be finite numbers`);
    }
    if (preference !== "a" && preference !== "b" && preference !== "equal") {
      throw new Error(`${id}: preference must be "a" | "b" | "equal"`);
    }
    return { id, score_a: scoreA, score_b: scoreB, preference };
  });
}

export function formatReport(report: TauReport, threshold = 0.4): string {
  const status = report.tau >= threshold ? "达标" : "未达标（按计划不 fail，仅人工抽检）";
  const lines = [
    `pairwise: ${report.pairCount} 对，concordant=${report.concordant} discordant=${report.discordant}`,
    `ties: model=${report.tiesModel} human=${report.tiesHuman}`,
    `Kendall τ-b = ${report.tau.toFixed(4)}（阈值 ${threshold}，${status}）`,
    // 置信区间为正态近似，样本量小时很宽——只作参考，不作达标依据。
    ...(report.confidenceInterval !== undefined
      ? [
          `τ 95% 近似置信区间: [${report.confidenceInterval.lower.toFixed(4)}, ${report.confidenceInterval.upper.toFixed(4)}]（正态近似，样本量小时区间宽，仅供参考）`,
        ]
      : []),
  ];
  if (report.disagreements.length > 0) {
    lines.push("不一致项：");
    for (const item of report.disagreements) {
      lines.push(`  - ${item.id}: model=${item.model} human=${item.human}`);
    }
  } else {
    lines.push("不一致项：无");
  }
  return lines.join("\n");
}

const DEFAULT_INPUT = "tests/patent/fixtures/pairwise/sample.jsonl";

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const argIndex = process.argv.indexOf("--input");
  const input = argIndex >= 0 ? process.argv[argIndex + 1] : DEFAULT_INPUT;
  if (input === undefined) {
    console.error("用法: tsx scripts/patent-pairwise-eval.ts [--input <jsonl>]");
    process.exit(1);
  }
  const report = kendallTauB(loadPairwiseJsonl(path.resolve(input)));
  console.log(formatReport(report));
  // 计划 M7：τ 未达标不阻断 CI。
  process.exit(0);
}
