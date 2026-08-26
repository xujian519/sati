/**
 * Benchmark —— 评测集目录布局与配置解析（对齐 PenguinHarness benchmarks/<id>/）。
 *
 * 目录约定（`benchmarks/<benchmark_id>/`）：
 *   - benchmark_config.yaml   名称/描述/target_role/评测运行时（Evaluator 与基准一致）
 *   - <case-id>/statement.md  公开：给被测 Target 角色跑的任务描述（不含 expected/rubric）
 *   - <case-id>/rubric.yaml   私有：分项评分标准，对 Target 完全隔离
 *   - scoreboard.yaml         追加式评测记录
 *   - snapshots/              被进化对象的版本快照（排除密钥）
 */

import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertSafeId } from "../persist-utils.js";

/** 评测运行时（Evaluator 实际使用的 provider/model/thinking 三元组）。 */
export type BenchmarkEvalRuntime = {
  provider: string;
  model_id: string;
  thinking_level: string;
};

export type BenchmarkConfig = {
  /** 基准名。 */
  name: string;
  description?: string;
  /** 被进化角色的 subagent_type id。 */
  target_role: string;
  /** 评测运行时；Optimizer 不得修改（分数跨版本可比的前提）。 */
  eval_runtime: BenchmarkEvalRuntime;
};

export type BenchmarkParseResult = { config: BenchmarkConfig; error: null } | { config: null; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 解析并校验 benchmark_config.yaml；容错归一（非法 → error，写入端据此拒用）。 */
export function parseBenchmarkConfig(text: string): BenchmarkParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return { config: null, error: `benchmark_config YAML parse failed: ${errorMessage(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { config: null, error: "benchmark_config must be a YAML mapping." };
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    return { config: null, error: "benchmark_config.name must be a non-empty string." };
  }
  if (typeof raw.target_role !== "string" || raw.target_role.trim().length === 0) {
    return { config: null, error: "benchmark_config.target_role must be a non-empty string." };
  }
  const runtime = raw.eval_runtime;
  if (typeof runtime !== "object" || runtime === null) {
    return { config: null, error: "benchmark_config.eval_runtime must be a mapping." };
  }
  const rt = runtime as Record<string, unknown>;
  if (typeof rt.provider !== "string" || rt.provider.length === 0) {
    return { config: null, error: "benchmark_config.eval_runtime.provider must be a string." };
  }
  if (typeof rt.model_id !== "string" || rt.model_id.length === 0) {
    return { config: null, error: "benchmark_config.eval_runtime.model_id must be a string." };
  }
  if (typeof rt.thinking_level !== "string" || rt.thinking_level.length === 0) {
    return { config: null, error: "benchmark_config.eval_runtime.thinking_level must be a string." };
  }
  const description = typeof raw.description === "string" ? raw.description : undefined;
  return {
    config: { name: raw.name, description, target_role: raw.target_role, eval_runtime: rt as BenchmarkEvalRuntime },
    error: null,
  };
}

export type BenchmarkPaths = {
  /** `benchmarks/<id>`。 */
  root: string;
  configPath: string;
  scoreboardPath: string;
  snapshotsDir: string;
  caseDir: (caseId: string) => string;
  statementPath: (caseId: string) => string;
  rubricPath: (caseId: string) => string;
};

/** 构造 benchmark 目录路径（id 经安全字符集校验，防路径注入）。 */
export function benchmarkPaths(root: string, benchmarkId: string): BenchmarkPaths {
  assertSafeId(benchmarkId, "benchmarkId");
  const dir = join(root, benchmarkId);
  const caseDir = (caseId: string): string => {
    assertSafeId(caseId, "caseId");
    return join(dir, caseId);
  };
  return {
    root: dir,
    configPath: join(dir, "benchmark_config.yaml"),
    scoreboardPath: join(dir, "scoreboard.yaml"),
    snapshotsDir: join(dir, "snapshots"),
    caseDir,
    statementPath: (caseId: string) => join(caseDir(caseId), "statement.md"),
    rubricPath: (caseId: string) => join(caseDir(caseId), "rubric.yaml"),
  };
}
