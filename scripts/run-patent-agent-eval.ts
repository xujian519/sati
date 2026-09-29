#!/usr/bin/env tsx
/**
 * 专利代理 Agent 回归评测入口（P0-2）。
 *
 * 手动命令（不进 CI）：全量跑批会触达模型（回放或真实调用），成本高。CI 只跑
 * createRegressionRunner 的确定性单测（tests/patent/evaluate-regression.spec.ts）。
 *
 * 目标执行 = 领域子图自动执行 + 规则门（未建图域走 provider 生成 + 规则门），
 * provider 由 ModelRuntime 装配：
 *   - --replay <fixture-dir>：走 llm-replay seam（无 key 确定性回放，推荐回归用）；
 *   - --live：用 pilot 配置的真实模型运行时（provider/model 默认取 benchmark_config
 *     的 eval_runtime，可经 --provider/--model 覆盖）。
 *
 * 逐用例算确定性指标（keyword_recall/citation_completeness/rule_gate_pass/jaccard/
 * conclusion_direction）→ Evaluator 聚合 BatchReport → 追加一条 ScoreboardRecord。
 *
 * Usage:
 *   pnpm eval:patent-agent --benchmark-id patent-agent --replay <fixture-dir> [--max-cases N] [--dry-run]
 *   pnpm eval:patent-agent --benchmark-id patent-agent --live [--provider deepseek --model deepseek-v4-flash]
 */
import { resolve } from "node:path";
import { exit } from "node:process";
import { readFileSync } from "node:fs";
import { loadPilotConfig } from "../src/pilot/index.js";
import { createModelRuntime, type ModelRuntime } from "../src/model/index.js";
import {
  benchmarkPaths,
  batchReportToScoreboardRecord,
  createProviderFromModelRuntime,
  createRegressionRunner,
  loadRegressionCases,
  parseBenchmarkConfig,
  readScoreboard,
  appendScoreboard,
  Evaluator,
} from "../src/patent/evaluate/index.js";
import { createReplayModelRuntime } from "../src/test-support/llm-replay/index.js";

function arg(flags: string[]): string | undefined {
  for (const f of flags) {
    const i = process.argv.indexOf(f);
    if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1]!.startsWith("--")) {
      return process.argv[i + 1];
    }
  }
  return undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const benchmarkRoot = resolve(arg(["--benchmark-root"]) ?? "benchmarks");
  const benchmarkId = arg(["--benchmark-id"]) ?? "patent-agent";
  const replayDir = arg(["--replay"]);
  const live = hasFlag("--live");
  const dryRun = hasFlag("--dry-run");
  const maxCasesRaw = arg(["--max-cases"]);
  const maxCases = maxCasesRaw !== undefined ? Number(maxCasesRaw) : undefined;

  const paths = benchmarkPaths(benchmarkRoot, benchmarkId);
  let configText: string;
  try {
    configText = readFileSync(paths.configPath, "utf8");
  } catch {
    console.error(`找不到 benchmark_config：${paths.configPath}`);
    exit(2);
  }
  const parsed = parseBenchmarkConfig(configText);
  if (parsed.config === null) {
    console.error(`benchmark_config 非法：${parsed.error}`);
    exit(2);
  }
  const config = parsed.config;

  const cases = await loadRegressionCases(paths);
  if (cases.length === 0) {
    console.error(`基准 ${benchmarkId} 下没有用例目录（需 statement.md + expected.md）。`);
    exit(2);
  }
  const selected = maxCases !== undefined && maxCases > 0 ? cases.slice(0, maxCases) : cases;

  const providerId = arg(["--provider"]) ?? config.eval_runtime.provider;
  const modelId = arg(["--model"]) ?? config.eval_runtime.model_id;

  let runtime: ModelRuntime;
  if (replayDir !== undefined) {
    // 回放需要一个 base runtime 应答能力查询；评测路径不触网，用只读桩即可。
    const base = capabilityOnlyRuntime();
    runtime = createReplayModelRuntime(resolve(replayDir), base);
  } else if (live) {
    const snapshot = loadPilotConfig({ projectRoot: process.cwd(), env: process.env });
    const base = createModelRuntime(snapshot.config.model);
    runtime = base;
  } else {
    console.error("必须指定 --replay <fixture-dir> 或 --live（真实模型，需 pilot 配置密钥）。");
    exit(2);
  }

  const stageProvider = createProviderFromModelRuntime(runtime, { provider: providerId, model: modelId });
  const evaluator = new Evaluator(createRegressionRunner(stageProvider));
  const report = await evaluator.evaluateCases(selected);

  const existing = await readScoreboard(paths.scoreboardPath);
  const version = (existing.error === null ? existing.records.length : 0) + 1;
  const record = batchReportToScoreboardRecord(
    report,
    { ...config, eval_runtime: { ...config.eval_runtime, provider: providerId, model_id: modelId } },
    version,
  );

  printSummary(benchmarkId, providerId, modelId, report, record.score);

  if (dryRun) {
    console.log("（--dry-run：未追加 scoreboard）");
    return;
  }
  const appended = await appendScoreboard(paths.scoreboardPath, record);
  if (!appended.ok) {
    console.error(`Scoreboard 追加失败：${appended.error}`);
    exit(1);
  }
  console.log(`已追加 ScoreboardRecord v${version}（共 ${appended.count} 条）→ ${paths.scoreboardPath}`);
}

function printSummary(
  benchmarkId: string,
  provider: string,
  model: string,
  report: {
    total: number;
    passed: number;
    degradedCount: number;
    metrics: Record<string, number>;
    cases: Array<{ caseId: string; metrics: Record<string, number>; verdict: string }>;
  },
  overall: number,
): void {
  console.log(`\n基准 ${benchmarkId} · ${provider}/${model}`);
  console.log(
    `用例 ${report.total}，达标 ${report.passed}，降级 ${report.degradedCount}，综合分 ${overall.toFixed(1)}/100`,
  );
  const metricLine = Object.entries(report.metrics)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join("  ");
  console.log(`指标均值：${metricLine}`);
  for (const c of report.cases) {
    const names = Object.keys(c.metrics);
    const avg = names.reduce((a, n) => a + (c.metrics[n] ?? 0), 0) / Math.max(1, names.length);
    console.log(`  - ${c.caseId}: ${(avg * 100).toFixed(1)}  规则门=${c.verdict}`);
  }
}

/** 回放路径的能力查询桩（stream 被 replay runtime 拦截，本桩只答能力查询）。 */
function capabilityOnlyRuntime(): ModelRuntime {
  const boom = (): never => {
    throw new Error("validation-only base runtime");
  };
  return {
    stream: function* () {
      yield* [];
      boom();
    },
    complete: async () => boom(),
    getCapabilities: () => ({
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

main().catch(error => {
  console.error(`评测失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  exit(1);
});
