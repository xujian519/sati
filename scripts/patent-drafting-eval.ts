#!/usr/bin/env tsx
/**
 * 起草质量 rubric 批量评测（#830 M5）。
 *
 * 对金标语料逐案计算五维分数（A26.3 / A26.4 / 结构 / 反套话 / 权要布局），
 * 输出 BatchReport 并以通过率作为退出码：
 * - clean 用例必须全部达到通过线；
 * - defect 用例必须全部在声明的期望维度上失分。
 *
 * 默认口径：语料是已记录的起草产物（claims + spec），评分本身零模型调用，因此不需要 API key。
 * `--live` 口径：用真实模型跑 `collectDraftingSignals`（enablement / claim_breadth 子图）
 * 取 A26.3 / A26.4 结论，并可对代表性子集跑完整 `runDraftingPipeline`；报告同时给出
 * 调用次数与 token，失败用例逐条列出，不静默回退成确定性代理。
 *
 * 用法：
 *   tsx scripts/patent-drafting-eval.ts
 *   tsx scripts/patent-drafting-eval.ts --corpus <path.jsonl> --pass-line 80 --json
 *   tsx scripts/patent-drafting-eval.ts --live [--provider deepseek --model deepseek-flash]
 *   tsx scripts/patent-drafting-eval.ts --live --pipeline-cases 4 --json
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CanonicalModelEvent, CanonicalUsage, ModelRuntime } from "../src/model/index.js";
import { createModelRuntime } from "../src/model/index.js";
import { createProviderFromModelRuntime } from "../src/patent/evaluate/index.js";
import {
  DEFAULT_DRAFTING_PASS_LINE,
  collectDraftingSignals,
  evaluateDraftingGolden,
  parseDraftingGoldenJsonl,
  runDraftingPipeline,
  scoreDraftingArtifacts,
  type DraftingDimensionId,
  type DraftingGoldenCase,
  type DraftingRubricResult,
  type DraftingSignals,
} from "../src/patent/index.js";
import { loadPilotConfig } from "../src/pilot/index.js";
import { kendallTauB, loadPairwiseJsonl } from "./patent-pairwise-eval.js";

const DEFAULT_CORPUS = "tests/patent/fixtures/drafting-golden/cases.jsonl";

type ScriptOptions = {
  corpus: string;
  passLine: number;
  json: boolean;
  live: boolean;
  /** 并列输出 pairwise 校准 τ（#830 M7 T7.4：撰写分与 τ 并列）。 */
  pairwise: boolean;
  provider?: string;
  model?: string;
  /** live 管线轮用例数（默认 4 = 2 clean + 2 defect；0 关闭管线轮）。 */
  pipelineCases: number;
};

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} 需要参数值`);
  return value;
}

function parseArgs(argv: readonly string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpus: DEFAULT_CORPUS,
    passLine: DEFAULT_DRAFTING_PASS_LINE,
    json: false,
    live: false,
    pairwise: false,
    pipelineCases: 4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--live") {
      options.live = true;
      continue;
    }
    if (arg === "--pairwise") {
      options.pairwise = true;
      continue;
    }
    if (arg === "--corpus") {
      options.corpus = readValue(argv, index, "--corpus");
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      options.provider = readValue(argv, index, "--provider");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      options.model = readValue(argv, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--pipeline-cases") {
      const value = Number(readValue(argv, index, "--pipeline-cases"));
      if (!Number.isInteger(value) || value < 0) throw new Error("--pipeline-cases 需要非负整数");
      options.pipelineCases = value;
      index += 1;
      continue;
    }
    if (arg === "--pass-line") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        throw new Error("--pass-line 需要 0-100 之间的数字");
      }
      options.passLine = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function formatCase(id: string, klass: string, total: number, status: string): string {
  return `  ${id.padEnd(30)} ${klass.padEnd(6)} ${total.toFixed(2).padStart(6)}  ${status}`;
}

// ---------------------------------------------------------------------------
// live 口径：真实模型 + token 计量
// ---------------------------------------------------------------------------

type UsageStats = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  nativeCost: number;
  nativeCostReported: boolean;
  /** 是否收到过 usage 事件；为 false 时上面的 token 数字不可读作 0。 */
  usageReported: boolean;
};

function emptyUsage(): UsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    nativeCost: 0,
    nativeCostReported: false,
    usageReported: false,
  };
}

function addUsage(stats: UsageStats, usage: CanonicalUsage): void {
  stats.usageReported = true;
  stats.inputTokens += usage.inputTokens ?? 0;
  stats.outputTokens += usage.outputTokens ?? 0;
  stats.cacheReadTokens += usage.cacheReadTokens ?? 0;
  stats.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  if (typeof usage.nativeCost === "number") {
    stats.nativeCost += usage.nativeCost;
    stats.nativeCostReported = true;
  }
}

/** 包装 ModelRuntime：透传全部能力查询，只统计 stream 的调用次数与 usage 事件。 */
function withUsageCounting(base: ModelRuntime): { runtime: ModelRuntime; stats: UsageStats } {
  const stats = emptyUsage();
  const runtime: ModelRuntime = {
    stream: async function* (request, runtimeOptions): AsyncIterable<CanonicalModelEvent> {
      stats.calls += 1;
      for await (const event of base.stream(request, runtimeOptions)) {
        if (event.type === "usage") addUsage(stats, event.usage);
        yield event;
      }
    },
    complete: (request, runtimeOptions) => base.complete(request, runtimeOptions),
    getCapabilities: (providerId, modelId) => base.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => base.getMultimodal(providerId, modelId),
    getProviderProtocol: providerId => base.getProviderProtocol(providerId),
    getProviderBaseUrl: providerId => base.getProviderBaseUrl(providerId),
  };
  const tokenLimitSources = base.getTokenLimitSources;
  if (tokenLimitSources !== undefined) {
    runtime.getTokenLimitSources = (providerId, modelId) => tokenLimitSources(providerId, modelId);
  }
  return { runtime, stats };
}

type LiveFailure = { id: string; stage: "signals" | "pipeline"; error: string };

type LiveSignalOutcome = {
  id: string;
  klass: DraftingGoldenCase["class"];
  total: number;
  passed: boolean;
  expectedFailures: DraftingDimensionId[];
  detectedFailures: DraftingDimensionId[];
  unverifiedDimensions: DraftingDimensionId[];
  graphDimensions: DraftingDimensionId[];
};

type LivePipelineOutcome = {
  id: string;
  klass: DraftingGoldenCase["class"];
  total: number;
  passed: boolean;
  claimsLength: number;
  specLength: number;
  degradedSteps: string[];
  unverifiedDimensions: DraftingDimensionId[];
  graphDimensions: DraftingDimensionId[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

type LiveReport = {
  provider: string;
  model: string;
  signals: {
    outcomes: LiveSignalOutcome[];
    failures: LiveFailure[];
    clean: { count: number; passed: number; mean: number };
    defect: { count: number; detected: number; mean: number };
    unverifiedDimensions: DraftingDimensionId[];
  };
  pipeline: {
    outcomes: LivePipelineOutcome[];
    failures: LiveFailure[];
    degradedSteps: string[];
  };
  usage: UsageStats;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function meanOf(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

/** 复用 rubric 计算，并区分「期望失分维度」与「实际失分维度」。 */
function scoreCase(
  item: DraftingGoldenCase,
  artifacts: { claims: string; spec: string },
  signals: DraftingSignals | undefined,
  passLine: number,
): { result: DraftingRubricResult; expectedFailures: DraftingDimensionId[]; detectedFailures: DraftingDimensionId[] } {
  const result = scoreDraftingArtifacts({ ...artifacts, requiredFeatures: item.requiredFeatures ?? [] }, signals, {
    passLine,
  });
  const expectedFailures = item.expectedFailures ?? [];
  const detectedFailures = expectedFailures.filter(dimension => {
    const scored = result.dimensions.find(entry => entry.id === dimension);
    return scored !== undefined && scored.score < scored.maxScore;
  });
  return { result, expectedFailures, detectedFailures };
}

function graphDimensionsOf(result: DraftingRubricResult): DraftingDimensionId[] {
  return result.dimensions.filter(dimension => dimension.signalSource === "graph").map(dimension => dimension.id);
}

async function runLive(options: ScriptOptions, cases: readonly DraftingGoldenCase[]): Promise<LiveReport> {
  const snapshot = loadPilotConfig({ projectRoot: process.cwd(), env: process.env });
  const agentRef = snapshot.config.agent.model;
  const providerId = options.provider ?? agentRef.provider;
  const modelId = options.model ?? agentRef.model;
  const { runtime, stats } = withUsageCounting(createModelRuntime(snapshot.config.model));
  const provider = createProviderFromModelRuntime(runtime, { provider: providerId, model: modelId });

  const signalOutcomes: LiveSignalOutcome[] = [];
  const failures: LiveFailure[] = [];
  for (const item of cases) {
    try {
      const signals = await collectDraftingSignals({ claims: item.claims, spec: item.spec }, { provider });
      const { result, expectedFailures, detectedFailures } = scoreCase(item, item, signals, options.passLine);
      signalOutcomes.push({
        id: item.id,
        klass: item.class,
        total: result.total,
        passed: result.passed,
        expectedFailures,
        detectedFailures,
        unverifiedDimensions: result.unverifiedDimensions,
        graphDimensions: graphDimensionsOf(result),
      });
    } catch (error) {
      failures.push({ id: item.id, stage: "signals", error: messageOf(error) });
    }
  }

  const pipelineOutcomes: LivePipelineOutcome[] = [];
  const pipelineFailures: LiveFailure[] = [];
  if (options.pipelineCases > 0) {
    const perClass = Math.max(1, Math.ceil(options.pipelineCases / 2));
    const selected = [
      ...cases.filter(item => item.class === "clean").slice(0, perClass),
      ...cases.filter(item => item.class === "defect").slice(0, perClass),
    ].slice(0, options.pipelineCases);
    for (const item of selected) {
      const callsBefore = stats.calls;
      const inputBefore = stats.inputTokens;
      const outputBefore = stats.outputTokens;
      try {
        const run = await runDraftingPipeline(item.disclosure, { provider });
        const signals = await collectDraftingSignals(run, { provider });
        const { result } = scoreCase(item, run, signals, options.passLine);
        pipelineOutcomes.push({
          id: item.id,
          klass: item.class,
          total: result.total,
          passed: result.passed,
          claimsLength: run.claims.length,
          specLength: run.spec.length,
          degradedSteps: run.degradedSteps,
          unverifiedDimensions: result.unverifiedDimensions,
          graphDimensions: graphDimensionsOf(result),
          calls: stats.calls - callsBefore,
          inputTokens: stats.inputTokens - inputBefore,
          outputTokens: stats.outputTokens - outputBefore,
        });
      } catch (error) {
        pipelineFailures.push({ id: item.id, stage: "pipeline", error: messageOf(error) });
      }
    }
  }

  const cleanOutcomes = signalOutcomes.filter(item => item.klass === "clean");
  const defectOutcomes = signalOutcomes.filter(item => item.klass === "defect");
  const unverified = new Set<DraftingDimensionId>();
  for (const item of signalOutcomes) {
    for (const dimension of item.unverifiedDimensions) unverified.add(dimension);
  }
  const degraded = new Set<string>();
  for (const item of pipelineOutcomes) {
    for (const step of item.degradedSteps) degraded.add(step);
  }

  return {
    provider: providerId,
    model: modelId,
    signals: {
      outcomes: signalOutcomes,
      failures,
      clean: {
        count: cleanOutcomes.length,
        passed: cleanOutcomes.filter(item => item.passed).length,
        mean: meanOf(cleanOutcomes.map(item => item.total)),
      },
      defect: {
        count: defectOutcomes.length,
        detected: defectOutcomes.filter(
          item => item.expectedFailures.length > 0 && item.detectedFailures.length === item.expectedFailures.length,
        ).length,
        mean: meanOf(defectOutcomes.map(item => item.total)),
      },
      unverifiedDimensions: [...unverified],
    },
    pipeline: { outcomes: pipelineOutcomes, failures: pipelineFailures, degradedSteps: [...degraded] },
    usage: stats,
  };
}

/**
 * pairwise 校准并列输出（#830 M7 T7.4）。
 *
 * 复用独立脚本 `patent-pairwise-eval.ts` 的计算口径（同一份实现，避免两套算法
 * 漂移）；τ 未达标只报告不 fail。校准数据缺失时显式说明，不静默跳过。
 */
function printPairwise(): void {
  const pairwisePath = resolve("tests/patent/fixtures/pairwise/sample.jsonl");
  console.log("");
  console.log("pairwise 校准（#830 M7）");
  if (!existsSync(pairwisePath)) {
    console.log("  校准数据缺失：tests/patent/fixtures/pairwise/sample.jsonl（未静默跳过）");
    return;
  }
  const report = kendallTauB(loadPairwiseJsonl(pairwisePath));
  console.log(
    `  ${report.pairCount} 对，concordant=${report.concordant} discordant=${report.discordant}，` +
      `ties: model=${report.tiesModel} human=${report.tiesHuman}`,
  );
  const interval =
    report.confidenceInterval !== undefined
      ? `，95% 近似置信区间 CI [${report.confidenceInterval.lower.toFixed(4)}, ${report.confidenceInterval.upper.toFixed(4)}]`
      : "";
  console.log(`  Kendall τ-b = ${report.tau.toFixed(4)}${interval}（未达标只报告，不 fail CI）`);
  if (report.disagreements.length > 0) {
    console.log("  不一致项：");
    for (const item of report.disagreements) {
      console.log(`    - ${item.id}: model=${item.model} human=${item.human}`);
    }
  }
}

function printLive(report: LiveReport): void {
  const { signals, pipeline, usage } = report;
  console.log("");
  console.log(`live 基线（${report.provider}/${report.model}，真实模型调用）`);
  console.log(`信号轮：${signals.outcomes.length} 件完成 / ${signals.failures.length} 件失败`);
  console.log(`  clean ${signals.clean.passed}/${signals.clean.count} 通过，均分 ${signals.clean.mean.toFixed(2)}`);
  console.log(
    `  defect ${signals.defect.detected}/${signals.defect.count} 检出，均分 ${signals.defect.mean.toFixed(2)}`,
  );
  console.log(`  未核验维度（仍用确定性代理）：${signals.unverifiedDimensions.join("、") || "无"}`);
  for (const item of signals.outcomes) {
    const status =
      item.klass === "clean"
        ? item.passed
          ? "pass"
          : "fail"
        : item.detectedFailures.length === item.expectedFailures.length
          ? "detected"
          : "missed";
    const graph = item.graphDimensions.length > 0 ? `  graph=[${item.graphDimensions.join(",")}]` : "";
    console.log(formatCase(item.id, item.klass, item.total, status) + graph);
  }
  if (pipeline.outcomes.length > 0 || pipeline.failures.length > 0) {
    console.log(`管线轮：${pipeline.outcomes.length} 件完成 / ${pipeline.failures.length} 件失败`);
    for (const item of pipeline.outcomes) {
      const status = item.passed ? "pass" : "fail";
      const degraded = item.degradedSteps.length > 0 ? `  degraded=[${item.degradedSteps.join(",")}]` : "";
      const tokens = usage.usageReported ? ` in=${item.inputTokens} out=${item.outputTokens}` : "";
      console.log(
        formatCase(item.id, item.klass, item.total, status) +
          `  claims=${item.claimsLength}字 spec=${item.specLength}字` +
          `  calls=${item.calls}${tokens}` +
          degraded,
      );
    }
    console.log(`  管线降级阶段（并集）：${pipeline.degradedSteps.join("、") || "无"}`);
  }
  if (usage.usageReported) {
    const cost = usage.nativeCostReported
      ? `，API 报告成本 ${usage.nativeCost.toFixed(6)}`
      : "，API 未返回成本（nativeCost 缺失）";
    console.log(
      `调用合计：${usage.calls} 次；输入 ${usage.inputTokens} tokens；输出 ${usage.outputTokens} tokens` +
        `（cache 读 ${usage.cacheReadTokens} / 写 ${usage.cacheWriteTokens}）${cost}`,
    );
  } else {
    console.log(`调用合计：${usage.calls} 次；token 用量 API 未返回（流式响应不含 usage 事件），不按 0 计。`);
  }
  const failures = [...signals.failures, ...pipeline.failures];
  if (failures.length > 0) {
    console.log("❌ 未完成（未回退、未计分）：");
    for (const failure of failures) console.log(`  ${failure.id} [${failure.stage}] ${failure.error}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const corpusPath = resolve(options.corpus);
  const cases = parseDraftingGoldenJsonl(readFileSync(corpusPath, "utf8"), options.corpus);
  const report = evaluateDraftingGolden(cases, { passLine: options.passLine });
  const live = options.live ? await runLive(options, cases) : undefined;

  if (options.json) {
    console.log(JSON.stringify(live === undefined ? report : { ...report, live }, null, 2));
  } else {
    console.log("起草质量 rubric 批量评测（#830 M5）");
    console.log(`语料：${options.corpus}`);
    console.log(
      `用例：${report.count}（clean ${report.clean.count} / defect ${report.defect.count}）  通过线：${report.passLine}`,
    );
    console.log(
      `clean 通过率 ${report.clean.passed}/${report.clean.count}（${(report.clean.passRate * 100).toFixed(0)}%）均分 ${report.clean.mean.toFixed(2)}`,
    );
    console.log(
      `defect 检出率 ${report.defect.detected}/${report.defect.count}（${(report.defect.detectionRate * 100).toFixed(0)}%）均分 ${report.defect.mean.toFixed(2)}`,
    );
    console.log(`未跑子图、使用确定性代理的维度：${report.unverifiedDimensions.join("、") || "无"}`);
    console.log("");
    for (const item of report.cases) {
      // defect 用例的判定是「期望维度是否失分」，不是总分过线——分开显示避免误读。
      const status =
        item.class === "clean"
          ? item.passed
            ? "pass"
            : "fail"
          : item.detectedFailures.length === item.expectedFailures.length
            ? "detected"
            : "missed";
      console.log(formatCase(item.id, item.class, item.total, status));
    }
    const cleanFailures = report.cases.filter(item => item.class === "clean" && !item.passed);
    const missedDefects = report.cases.filter(
      item => item.class === "defect" && item.detectedFailures.length !== item.expectedFailures.length,
    );
    if (cleanFailures.length > 0 || missedDefects.length > 0) {
      console.log("");
      console.log("失败用例：");
      for (const item of cleanFailures) console.log(`  ${item.id}：clean 未达通过线（${item.total}）`);
      for (const item of missedDefects) {
        const missed = item.expectedFailures.filter(dimension => !item.detectedFailures.includes(dimension));
        console.log(`  ${item.id}：未在 ${missed.join("、")} 失分`);
      }
    }
    if (live !== undefined) printLive(live);
    // pairwise 校准并列输出（#830 M7 T7.4）：撰写分与 τ 同屏，便于对照解读。
    // τ 未达标只报告不 fail（与独立脚本口径一致）。
    if (options.pairwise) printPairwise();
  }

  const cleanOk = report.clean.passRate === 1;
  const defectOk = report.defect.detectionRate === 1;
  // live 失败必须影响退出码：否则「没跑成」会被误读成通过。
  const liveOk = live === undefined || (live.signals.failures.length === 0 && live.pipeline.failures.length === 0);
  process.exitCode = cleanOk && defectOk && liveOk ? 0 : 1;
}

await main();
