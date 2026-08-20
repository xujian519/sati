/**
 * 溯源 runId 实例化（方案 P2）。
 *
 * 背景：runId 是 provenance activity 幂等键的第一段，必须满足"同一运行实例
 * （含 resume 续跑）复用同一 runId、新运行用新 runId"——否则 resume 重放产生
 * 重复记录、或确定性 runId 导致合法重跑覆盖前次审计历史。
 *
 * 实现：per-case 库目录下持久化 `<runKey>.run.json`（runKey = manifestId / graphId），
 * 续跑调用（有 resume/approve 参数）读回既有 runId，新运行生成新 runId 并落盘。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseProvenanceDir } from "../paths.js";

export type ResolveProvenanceRunIdOptions = {
  caseId: string;
  /** 解析 case 路径的 cwd（三态解析，与 caseProvenanceDir 一致）。 */
  cwd: string;
  /** manifestId 或 graphId（"patent_drafting_v1"/"patent_inventiveness"）。 */
  runKey: string;
  /** 本次调用是否续跑（有 resume/approve 参数）：true 时复用既有 runId。 */
  resume: boolean;
};

/** 读取既有 runId（文件缺失/损坏返回 undefined）。 */
function readPersistedRunId(file: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { runId?: unknown };
    return typeof data.runId === "string" && data.runId.length > 0 ? data.runId : undefined;
  } catch {
    return undefined;
  }
}

/** 进程内递增序号：同毫秒内多次新建仍唯一（跨进程靠 pid 区分）。 */
let runSeq = 0;

/** 解析（或新建）本次运行的 runId。 */
export function resolveProvenanceRunId(options: ResolveProvenanceRunIdOptions): string {
  const dir = caseProvenanceDir(options.caseId, options.cwd);
  const file = join(dir, `${options.runKey}.run.json`);
  if (options.resume) {
    const existing = readPersistedRunId(file);
    if (existing !== undefined) return existing;
  }
  runSeq += 1;
  const runId = `${options.runKey}-${Date.now()}-${process.pid}-${runSeq}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ runId, createdAt: new Date().toISOString() }, null, 2), "utf8");
  return runId;
}
