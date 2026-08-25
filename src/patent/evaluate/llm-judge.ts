/**
 * src/patent/evaluate — LLM Rubric Judge（对齐 Mady evaluate/judge_metrics.go）。
 *
 * 对主观长文本按 rubric 打分：
 * - llmJudge：同一 judge 采样 N 次（缺省 3）取中位数抑制方差（单模型路径）；
 * - collectJudgeVotes：多 judge（不同 modelHint/provider）并行投票 → 共识层
 *   输入（见 ./consensus.ts）；每 judge 采样中位数计一票，任一 judge 失败
 *   失败票跳过（≥1 有效票即判，fail-open）。
 */

import { dataBlock } from "../prompt-hygiene.js";

export type LlmJudgeOptions = {
  /** 打分次数（缺省 3，取中位数）。 */
  samples?: number;
  /** 温度（缺省 0，评分应低随机性；可传 0.2 增加采样差异）。 */
  temperature?: number;
  /** 附加 rubric 提示（如"关注结论与推理一致性"）。 */
  rubric?: string;
};

export type LlmJudgeClient = {
  callLLM: (prompt: string, opts?: { jsonSchema?: unknown; temperature?: number }) => Promise<string>;
};

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", description: "0-1 评分" },
    rationale: { type: "string", description: "评分理由" },
  },
  required: ["score", "rationale"],
} as const;

/** 从 LLM 输出解析 0-1 分数（容忍 JSON 包裹/纯数字文本）。 */
export function parseJudgeScore(raw: string): number | undefined {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{\s*"score"\s*:\s*([\d.]+)/);
  if (jsonMatch) {
    const score = Number(jsonMatch[1]);
    return Number.isFinite(score) ? clamp(score) : undefined;
  }
  const numMatch = trimmed.match(/([\d.]+)/);
  if (numMatch) {
    const score = Number(numMatch[1]);
    return Number.isFinite(score) ? clamp(score) : undefined;
  }
  return undefined;
}

/**
 * LLM Rubric Judge：N 次采样取中位数。
 * 全部采样解析失败时返回 undefined（调用方决定降级策略）。
 */
export async function llmJudge(
  judge: LlmJudgeClient,
  question: string,
  answer: string,
  expected: string | undefined,
  options: LlmJudgeOptions = {},
): Promise<number | undefined> {
  const samples = options.samples ?? 3;
  const prompt = buildJudgePrompt(question, answer, expected, options.rubric ?? "");

  const scores: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < samples; i += 1) {
    try {
      const raw = await judge.callLLM(prompt, { jsonSchema: JUDGE_SCHEMA, temperature: options.temperature ?? 0 });
      const score = parseJudgeScore(raw);
      if (score !== undefined) scores.push(score);
      else failures.push(`采样 ${i + 1} 解析失败: ${raw.slice(0, 80)}`);
    } catch (err) {
      failures.push(`采样 ${i + 1} 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (scores.length === 0) return undefined;
  return median(scores);
}

/** 单个 judge 采样一次并解析（失败返回 undefined，不抛）。 */
async function judgeSample(
  judge: LlmJudgeClient,
  prompt: string,
  temperature: number,
): Promise<{ score: number; rationale?: string } | undefined> {
  try {
    const raw = await judge.callLLM(prompt, { jsonSchema: JUDGE_SCHEMA, temperature });
    const score = parseJudgeScore(raw);
    if (score === undefined) return undefined;
    const rationale = raw.match(/"rationale"\s*:\s*"([^"]{4,})"/)?.[1];
    return { score, ...(rationale !== undefined ? { rationale } : {}) };
  } catch {
    // 单次采样调用/解析失败：返回 undefined 交由 collectJudgeVotes 跳过该票。
    return undefined;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// 多 judge 投票（共识层输入）
// ---------------------------------------------------------------------------

export type NamedJudge = LlmJudgeClient & {
  /** 判定者标识（如 "judge:a"）。 */
  judgeId: string;
  /** 审计：provider。 */
  provider?: string;
  /** 审计：model。 */
  model?: string;
};

export type JudgeVoteOptions = {
  /** 每 judge 采样次数（缺省 1；每 judge 的中位计一票）。 */
  samples?: number;
  /** 温度（缺省 0）。 */
  temperature?: number;
  /** 附加 rubric 提示。 */
  rubric?: string;
};

/**
 * 多 judge 并行投票（同一 prompt；各 judge 独立采样与解析）。
 * 失败 judge 跳过（不因单点失败放弃共识）；全部失败返回空数组。
 */
export async function collectJudgeVotes(
  judges: readonly NamedJudge[],
  question: string,
  answer: string,
  expected: string | undefined,
  options: JudgeVoteOptions = {},
): Promise<import("./consensus.js").JudgeVote[]> {
  const prompt = buildJudgePrompt(question, answer, expected, options.rubric ?? "");
  const samples = options.samples ?? 1;
  const temperature = options.temperature ?? 0;
  const results = await Promise.all(
    judges.map(async judge => {
      const scores: Array<{ score: number; rationale?: string }> = [];
      for (let i = 0; i < samples; i += 1) {
        const sample = await judgeSample(judge, prompt, temperature);
        if (sample !== undefined) scores.push(sample);
      }
      if (scores.length === 0) return undefined;
      const score = median(scores.map(s => s.score));
      const rationale = scores.find(s => s.rationale !== undefined)?.rationale;
      return {
        judgeId: judge.judgeId,
        ...(judge.provider !== undefined ? { provider: judge.provider } : {}),
        ...(judge.model !== undefined ? { model: judge.model } : {}),
        score,
        ...(rationale !== undefined ? { rationale } : {}),
      };
    }),
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== undefined);
}

function buildJudgePrompt(question: string, answer: string, expected: string | undefined, rubric: string): string {
  return [
    "你是专利领域质量评估法官。基于以下评分标准，对 AI 产出评分（0-1）：",
    "- 结论正确性（与参考答案要旨一致）",
    "- 论证完整性（三性/充分公开等法律框架是否完整）",
    "- 引用与依据（法条/对比文件引用是否准确）",
    rubric,
    "",
    "【题目】",
    dataBlock(question.slice(0, 4000)),
    "",
    expected !== undefined ? `【参考答案要点】\n${dataBlock(expected.slice(0, 2000))}\n` : "",
    "【AI 产出】",
    dataBlock(answer.slice(0, 6000)),
    "",
    "请严格输出 JSON：{ score（0-1）, rationale }。",
  ].join("\n");
}
