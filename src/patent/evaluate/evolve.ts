/**
 * evolve —— 自进化闭环的单次评测链路（对齐 PenguinHarness `baseline`）。
 *
 * 职责（M2）：对冻结 case 集逐条 —— statement（公开，给被测 Agent）→ 生成产出 →
 *   按私有 rubric 判「可观察行为」得分 → 聚合为该版本一条 ScoreboardRecord → 落 scoreboard。
 *
 * 隔离（与 PenguinHarness statement/rubric 隔离对齐）：
 *   - `generate` 只拿到 statement（不含 rubric / expected）；
 *   - `judge` 同时拿到 output 与 rubric（评分侧视角），二者在 `runBaseline` 处被注入函数
 *     分开，rubric 内容永不流入生成侧上下文。
 *
 * LLM 细节（provider / prompt / structured output）由调用方注入，本模块只做文件 I/O、
 * 隔离与聚合——便于用 mock 进行无 key 单测。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { jsonrepair } from "jsonrepair";
import { parseRubric, type Rubric, type RubricItem } from "./rubric.js";
import type { BenchmarkConfig, BenchmarkPaths } from "./benchmark.js";
import { appendScoreboard, type ScoreboardRecord } from "./scoreboard.js";

/** 生成侧注入：喂 statement，返回产出文本 + 本次 run 的 session 引用与耗时。 */
export type BaselineGenerate = (
  systemPrompt: string,
  statement: string,
) => Promise<{
  text: string;
  sessionId: string;
  durationMs: number;
}>;

/** 评分侧注入：喂 statement + 产出 + rubric，返回 0..maxScore 分数。 */
export type BaselineJudge = (statement: string, output: string, rubric: Rubric) => Promise<number>;

export type RunBaselineArgs = {
  paths: BenchmarkPaths;
  config: BenchmarkConfig;
  /** 本版本号（已由调用方从 scoreboard 推导递增）。 */
  version: number;
  generate: BaselineGenerate;
  judge: BaselineJudge;
  now?: () => Date;
  maxCases?: number;
  /** 每 case 的 run 次数（M3 batch；默认 1 = baseline）。 */
  runs?: number;
};

export type BaselineResult = {
  record: ScoreboardRecord;
  /** 追加后 scoreboard 记录总数。 */
  count: number;
  casesRun: number;
};

/** 列出基准目录下满足 statement.md + rubric.yaml 的 case 目录（安全 id）。 */
export async function listCaseDirs(paths: BenchmarkPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const cases: string[] = [];
  for (const name of entries) {
    const dir = join(paths.root, name);
    // 只认目录且含 statement.md + rubric.yaml
    try {
      await readFile(join(dir, "statement.md"), "utf8");
      await readFile(join(dir, "rubric.yaml"), "utf8");
      cases.push(name);
    } catch {
      // 非 case 目录（如 benchmark_config.yaml 同级文件、snapshots/）跳过
    }
  }
  return cases.sort();
}

/**
 * 跑一遍单次评测（baseline：每 case 1 run），聚合为一条 ScoreboardRecord 并追加。
 * 任一 case 的生成/评分失败使整体 fail-closed（reject，不 append），避免只写半份
 * 误导性评分；调用方另行处理重试（重新 runBaseline）。
 */
export async function runBaseline(args: RunBaselineArgs): Promise<BaselineResult> {
  const { paths, config, version, generate, judge, now = () => new Date() } = args;
  const runsCount = args.runs ?? 1;
  const caseIds = await listCaseDirs(paths);
  const limit = args.maxCases !== undefined ? Math.min(caseIds.length, args.maxCases) : caseIds.length;
  const selected = caseIds.slice(0, limit);

  const cases: ScoreboardRecord["cases"] = [];
  for (const caseId of selected) {
    const statement = await readFile(paths.statementPath(caseId), "utf8");
    const rubricResult = parseRubric(await readFile(paths.rubricPath(caseId), "utf8"));
    if (rubricResult.rubric === null) {
      throw new Error(`case ${caseId} rubric 非法: ${rubricResult.error}`);
    }
    const rubric = rubricResult.rubric;

    const runs: ScoreboardRecord["cases"][number]["runs"] = [];
    for (let k = 0; k < runsCount; k++) {
      const generated = await generate(config.target_role, statement);
      const score = await judge(statement, generated.text, rubric);
      runs.push({
        score,
        cost: null,
        duration_ms: Math.round(generated.durationMs),
        session_id: generated.sessionId,
      });
    }
    cases.push({ case: caseId, score: round2(mean(runs.map(r => r.score))), runs });
  }

  const record: ScoreboardRecord = {
    time: now().toISOString(),
    version,
    provider: config.eval_runtime.provider,
    model_id: config.eval_runtime.model_id,
    thinking_level: config.eval_runtime.thinking_level,
    score: round2(mean(cases.map(c => c.score))),
    cost: null,
    duration_ms: Math.round(mean(cases.flatMap(c => c.runs.map(r => r.duration_ms)))),
    cases,
  };
  const appended = await appendScoreboard(paths.scoreboardPath, record);
  if (!appended.ok) {
    throw new Error(`Scoreboard 追加失败: ${appended.error}`);
  }
  return { record, count: appended.count, casesRun: cases.length };
}

// ---------------------------------------------------------------------------
// M3：多 run（batch）诊断与 diff
// ---------------------------------------------------------------------------

/** 单个 case 在两版分数之间的变化。 */
export type CaseDiff = {
  caseId: string;
  older: number | null;
  newer: number | null;
  delta: number | null;
};

/** 两版评测的差异总览（M3 diff 诊断）。 */
export type ScoreboardDiff = {
  olderVersion: number;
  newerVersion: number;
  olderScore: number | null;
  newerScore: number | null;
  delta: number | null;
  /** 逐 case 明细。 */
  cases: CaseDiff[];
  /** 分数下降的 case id（诊断失分点）。 */
  lost: string[];
  /** 分数上升或持平的 case id。 */
  improvedOrFlat: string[];
};

/** 按 case 对齐比较两版记录；单边缺失的 case 记 null。 */
export function diffScoreboards(older: ScoreboardRecord, newer: ScoreboardRecord): ScoreboardDiff {
  const ids = [...new Set([...older.cases.map(c => c.case), ...newer.cases.map(c => c.case)])].sort();
  const olderScore = new Map(older.cases.map(c => [c.case, c.score]));
  const newerScore = new Map(newer.cases.map(c => [c.case, c.score]));
  const cases: CaseDiff[] = ids.map(caseId => {
    const o = olderScore.get(caseId) ?? null;
    const n = newerScore.get(caseId) ?? null;
    return { caseId, older: o, newer: n, delta: o !== null && n !== null ? round2(n - o) : null };
  });
  const lost = cases.filter(c => c.delta !== null && c.delta < 0).map(c => c.caseId);
  const improvedOrFlat = cases.filter(c => c.delta !== null && c.delta >= 0).map(c => c.caseId);

  const overallDelta = older.score === null || newer.score === null ? null : round2(newer.score - older.score);
  return {
    olderVersion: older.version,
    newerVersion: newer.version,
    olderScore: older.score,
    newerScore: newer.score,
    delta: overallDelta,
    cases,
    lost,
    improvedOrFlat,
  };
}

// ---------------------------------------------------------------------------
// M4：严格接受规则（分数严格更高才接受，否则回滚）
// ---------------------------------------------------------------------------

export type StrictAcceptDecision = {
  accepted: boolean;
  reason: string;
};

/** 严格接受：candidate 必须**严格**高于 reference 才接受（相等视为拒绝，防原地踏步）。 */
export function shouldAcceptCandidate(candidateScore: number, referenceScore: number): boolean {
  return candidateScore > referenceScore;
}

/** 评估候选版本相对参考版本是否应被接受（M4）。 */
export function evaluateCandidate(candidate: ScoreboardRecord, reference: ScoreboardRecord): StrictAcceptDecision {
  const c = candidate.score;
  const r = reference.score;
  if (c > r) {
    return {
      accepted: true,
      reason: `candidate v${candidate.version} (${c}) 严格高于 reference v${reference.version} (${r})。`,
    };
  }
  return {
    accepted: false,
    reason: `candidate v${candidate.version} (${c}) 未严格高于 reference v${reference.version} (${r})，需回滚。`,
  };
}

/** 构造面向 LLM judge 的评分提示：每条 rubric 项都是"行为是否发生"的真假判定。 */
export function buildJudgePrompt(statement: string, output: string, rubric: Rubric): string {
  const lines = rubric.items.map((it, i) => `${i + 1}. [${it.id}]（权重 ${it.weight}）${it.criterion}`).join("\n");
  return `你是严格的评测员。以下是任务背景、被测产出一个评分标准。请逐条判断各项"可观察行为/缺陷是否发生"，只输出 JSON。

【任务背景】
${statement}

【被测产出】
${output}

【评分标准】
${lines}

【输出要求】
只输出一个 JSON 对象，键为各项 id，值为 true（行为发生/要求满足）或 false（未发生/未满足）。不要输出任何解释、markdown 围栏或多余文字。示例：{${rubric.items.map(it => `"${it.id}": true`).join(", ")}}`;
}

/**
 * 解析 judge 的 JSON 输出为逐项布尔判定。未解析到的项保守取 false（未通过，避免高保底分）——
 * 对齐 PenguinHarness"评分项必须可观察、避免高保底分"的约束。
 */
export function parseVerdicts(text: string, items: RubricItem[]): Record<string, boolean> {
  const verdicts: Record<string, boolean> = {};
  for (const item of items) verdicts[item.id] = false;
  const obj = extractJsonObject(text);
  if (obj === null) return verdicts;
  for (const item of items) {
    const coerced = coerceBoolean(obj[item.id]);
    if (coerced !== undefined) verdicts[item.id] = coerced;
  }
  return verdicts;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  try {
    const repaired = jsonrepair(text);
    const parsed = JSON.parse(repaired) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(jsonrepair(text.slice(start, end + 1))) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fallthrough
    }
  }
  return null;
}

function coerceBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw > 0;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (["true", "yes", "y", "1", "pass", "passed"].includes(s)) return true;
    if (["false", "no", "n", "0", "fail", "failed"].includes(s)) return false;
  }
  return undefined;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
