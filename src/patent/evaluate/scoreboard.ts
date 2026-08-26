/**
 * Scoreboard —— 评测记录（追加式 YAML 列表），对齐 PenguinHarness scoreboard.yaml。
 *
 * 每个记录是一次完整评测（一个版本 × 冻结 case 集），pin 到产生它的 session_id，
 * 以便分数可回溯到实际运行。服务端**不重算、不交叉校验**——已写入的聚合值即权威
 * （这是刻意约定，防止模型/前端不一致；本模块只保证"追加不覆盖 + 写后自校验"）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** 单次 run 的分数与运行引用。 */
export type ScoreboardRun = {
  /** 0..100。 */
  score: number;
  cost: number | null;
  duration_ms: number;
  /** 产生这次 run 的 session（回溯到 Trace）。 */
  session_id: string;
};

/** 单个 case 的聚合（跨 runs 的平均）。 */
export type ScoreboardCase = {
  case: string;
  score: number;
  runs: ScoreboardRun[];
};

/** 一条完整评测记录。 */
export type ScoreboardRecord = {
  time: string;
  version: number;
  provider: string;
  model_id: string;
  thinking_level: string;
  /** 0..100 平均。 */
  score: number;
  cost: number | null;
  duration_ms: number;
  cases: ScoreboardCase[];
};

export type ScoreboardReadResult =
  | { records: ScoreboardRecord[]; error: null }
  | { records: ScoreboardRecord[]; error: string };

export type ScoreboardAppendResult = { ok: true; count: number } | { ok: false; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

/** 校验一条记录 shape；非法返回错误消息列表（空 = 合法）。 */
export function validateScoreboardRecord(record: unknown): string[] {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["Scoreboard record must be a mapping."];
  }
  const r = record as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof r.time !== "string") errors.push("record.time must be a string.");
  if (!isFiniteNumber(r.version)) errors.push("record.version must be a number.");
  if (typeof r.provider !== "string") errors.push("record.provider must be a string.");
  if (typeof r.model_id !== "string") errors.push("record.model_id must be a string.");
  if (typeof r.thinking_level !== "string") errors.push("record.thinking_level must be a string.");
  if (!isFiniteNumber(r.score)) errors.push("record.score must be a number.");
  if (!isNullableNumber(r.cost)) errors.push("record.cost must be a number or null.");
  if (!isFiniteNumber(r.duration_ms)) errors.push("record.duration_ms must be a number.");
  if (!Array.isArray(r.cases)) {
    errors.push("record.cases must be a list.");
    return errors;
  }
  for (let i = 0; i < r.cases.length; i++) {
    const c = r.cases[i];
    if (typeof c !== "object" || c === null) {
      errors.push(`record.cases[${i}] must be a mapping.`);
      continue;
    }
    const cc = c as Record<string, unknown>;
    if (typeof cc.case !== "string") errors.push(`record.cases[${i}].case must be a string.`);
    if (!isFiniteNumber(cc.score)) errors.push(`record.cases[${i}].score must be a number.`);
    if (!Array.isArray(cc.runs)) {
      errors.push(`record.cases[${i}].runs must be a list.`);
      continue;
    }
    for (let j = 0; j < cc.runs.length; j++) {
      const run = cc.runs[j];
      if (typeof run !== "object" || run === null) {
        errors.push(`record.cases[${i}].runs[${j}] must be a mapping.`);
        continue;
      }
      const rr = run as Record<string, unknown>;
      if (!isFiniteNumber(rr.score)) errors.push(`record.cases[${i}].runs[${j}].score must be a number.`);
      if (!isNullableNumber(rr.cost)) errors.push(`record.cases[${i}].runs[${j}].cost must be a number or null.`);
      if (!isFiniteNumber(rr.duration_ms)) errors.push(`record.cases[${i}].runs[${j}].duration_ms must be a number.`);
      if (typeof rr.session_id !== "string") errors.push(`record.cases[${i}].runs[${j}].session_id must be a string.`);
    }
  }
  return errors;
}

/**
 * 读取 scoreboard（容错）：文件缺失 → 空列表；非法 YAML / 任意记录 shape 非法 →
 * `error`（写入端据此拒写，防污染）。
 */
export async function readScoreboard(path: string): Promise<ScoreboardReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], error: null };
    }
    return { records: [], error: `Read scoreboard failed: ${errorMessage(error)}` };
  }
  if (raw.trim().length === 0) {
    return { records: [], error: null };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    return { records: [], error: `Scoreboard YAML parse failed: ${errorMessage(error)}` };
  }
  if (parsed === undefined || parsed === null) return { records: [], error: null };
  if (!Array.isArray(parsed)) {
    return { records: [], error: "Scoreboard must be a YAML list of records." };
  }
  const records: ScoreboardRecord[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const errors = validateScoreboardRecord(parsed[i]);
    if (errors.length > 0) {
      return { records: [], error: `Scoreboard record [${i}] invalid: ${errors[0]}` };
    }
    records.push(parsed[i] as ScoreboardRecord);
  }
  return { records, error: null };
}

async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

/**
 * 追加一条评测记录并写后自校验（防少写/半写）。记录先校验；现有库非法时不追加
 * （fail-closed）。成功时返回新记录总数。
 */
export async function appendScoreboard(path: string, record: ScoreboardRecord): Promise<ScoreboardAppendResult> {
  const recordErrors = validateScoreboardRecord(record);
  if (recordErrors.length > 0) {
    return { ok: false, error: `Record invalid: ${recordErrors[0]}` };
  }
  const existing = await readScoreboard(path);
  if (existing.error !== null) {
    return { ok: false, error: `Existing scoreboard invalid: ${existing.error}` };
  }
  const records = [...existing.records, record];
  await atomicWriteText(path, `${stringifyYaml(records)}\n`);
  const verified = await readScoreboard(path);
  if (verified.error !== null) {
    return { ok: false, error: `Post-write verify failed: ${verified.error}` };
  }
  if (verified.records.length !== records.length) {
    return {
      ok: false,
      error: `Post-write verify count mismatch: wrote ${records.length}, read ${verified.records.length}.`,
    };
  }
  return { ok: true, count: verified.records.length };
}
