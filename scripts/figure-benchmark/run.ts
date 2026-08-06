/**
 * scripts/figure-benchmark/run.ts
 *
 * 真实专利附图基准测试运行器。
 *
 * 用法：
 *   tsx scripts/figure-benchmark/run.ts [--provider moonshot] [--model kimi-k3] [--limit N]
 *
 * 读取 ~/.sati/benchmark/manifest.json 中的 ground truth，对每张附图调用
 * analyze_patent_figure，并将预测结果与人工标注对比，输出指标与详细结果。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPilotConfig } from "../../src/pilot/config/loadPilotConfig.js";
import { createModelRuntime, type ModelRuntime } from "../../src/model/index.js";
import { createAnalyzePatentFigureTool } from "../../src/tool/builtin/analyzePatentFigure.js";
import type { SatiToolModelClient, SatiToolRuntimeContext } from "../../src/tool/protocol/types.js";
import type { FigureAnalysisResult, FigureComponent, FigureType } from "../../src/patent/figure/types.js";

const BENCHMARK_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".sati", "benchmark");
const MANIFEST_PATH = path.join(BENCHMARK_DIR, "manifest.json");
const RESULTS_DIR = path.join(BENCHMARK_DIR, "results");

type BenchmarkFigure = {
  id: string;
  imageFile: string;
  sourceCase: string;
  sourceFile: string;
  figureNumber: number;
  title: string;
  humanFigureType: FigureType;
  expectedRefNumbers: string[];
  keyComponents: { refNumber: string; name: string }[];
  notes?: string;
};

type BenchmarkManifest = {
  version: number;
  name: string;
  description: string;
  createdAt: string;
  figuresDir: string;
  figures: BenchmarkFigure[];
};

type FigureResult = {
  id: string;
  imageFile: string;
  figureNumber: number;
  humanFigureType: FigureType;
  predicted: FigureAnalysisResult | null;
  error?: string;
  metrics: {
    typeCorrect: boolean;
    expectedRefCount: number;
    predictedRefCount: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    refPrecision: number;
    refRecall: number;
    refF1: number;
    usable: boolean;
    confidence: number;
  };
  durationMs: number;
};

type BenchmarkRun = {
  runAt: string;
  provider: string;
  model: string;
  durationMs: number;
  summary: {
    total: number;
    success: number;
    failed: number;
    typeAccuracy: number;
    avgRefPrecision: number;
    avgRefRecall: number;
    avgRefF1: number;
    avgConfidence: number;
    usableRate: number;
  };
  results: FigureResult[];
};

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith("--") && value !== undefined) {
      args[key.slice(2)] = value;
    }
  }
  return {
    provider: args.provider ?? "moonshot",
    model: args.model ?? "kimi-k3",
    limit: args.limit ? Number(args.limit) : undefined,
  };
}

async function loadManifest(): Promise<BenchmarkManifest> {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as BenchmarkManifest;
}

function createToolContext(cwd: string, model: ModelRuntime): SatiToolRuntimeContext {
  return {
    sessionId: `benchmark-${Date.now()}`,
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    model: model as unknown as SatiToolModelClient,
  };
}

function normalizeRefNumber(num: string | number): string {
  return String(num).trim();
}

function computeRefMetrics(expected: string[], predictedComponents: FigureComponent[]): FigureResult["metrics"] {
  const expectedSet = new Set(expected.map(normalizeRefNumber));
  const predictedSet = new Set(predictedComponents.map(c => normalizeRefNumber(c.refNumber)));

  let tp = 0;
  for (const ref of expectedSet) {
    if (predictedSet.has(ref)) tp++;
  }
  const fp = predictedSet.size - tp;
  const fn = expectedSet.size - tp;

  const precision = predictedSet.size > 0 ? tp / predictedSet.size : expectedSet.size === 0 ? 1 : 0;
  const recall = expectedSet.size > 0 ? tp / expectedSet.size : predictedSet.size === 0 ? 1 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    typeCorrect: false, // filled later
    expectedRefCount: expectedSet.size,
    predictedRefCount: predictedSet.size,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    refPrecision: precision,
    refRecall: recall,
    refF1: f1,
    usable: false, // filled later
    confidence: 0, // filled later
  };
}

async function runFigure(
  figure: BenchmarkFigure,
  tool: ReturnType<typeof createAnalyzePatentFigureTool>,
  context: SatiToolRuntimeContext,
): Promise<FigureResult> {
  const start = performance.now();
  const imagePath = path.join(BENCHMARK_DIR, "figures", figure.imageFile);

  try {
    const output = await tool.execute(
      {
        image_path: imagePath,
        figure_number: figure.figureNumber,
      },
      context,
    );
    const predicted = output.data ?? null;
    const durationMs = Math.round(performance.now() - start);

    if (!predicted) {
      return {
        id: figure.id,
        imageFile: figure.imageFile,
        figureNumber: figure.figureNumber,
        humanFigureType: figure.humanFigureType,
        predicted: null,
        error: "工具未返回 data",
        metrics: computeRefMetrics(figure.expectedRefNumbers, []),
        durationMs,
      };
    }

    const metrics = computeRefMetrics(figure.expectedRefNumbers, predicted.components);
    metrics.typeCorrect = predicted.figureType === figure.humanFigureType;
    metrics.usable = predicted.usable;
    metrics.confidence = predicted.confidence ?? 0;

    return {
      id: figure.id,
      imageFile: figure.imageFile,
      figureNumber: figure.figureNumber,
      humanFigureType: figure.humanFigureType,
      predicted,
      metrics,
      durationMs,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    return {
      id: figure.id,
      imageFile: figure.imageFile,
      figureNumber: figure.figureNumber,
      humanFigureType: figure.humanFigureType,
      predicted: null,
      error: error instanceof Error ? error.message : String(error),
      metrics: computeRefMetrics(figure.expectedRefNumbers, []),
      durationMs,
    };
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function summarize(results: FigureResult[]): BenchmarkRun["summary"] {
  const total = results.length;
  const success = results.filter(r => r.predicted !== null && !r.error).length;
  const failed = total - success;

  return {
    total,
    success,
    failed,
    typeAccuracy: average(results.filter(r => r.predicted).map(r => (r.metrics.typeCorrect ? 1 : 0))),
    avgRefPrecision: average(results.map(r => r.metrics.refPrecision)),
    avgRefRecall: average(results.map(r => r.metrics.refRecall)),
    avgRefF1: average(results.map(r => r.metrics.refF1)),
    avgConfidence: average(results.filter(r => r.predicted).map(r => r.metrics.confidence)),
    usableRate: average(results.filter(r => r.predicted).map(r => (r.metrics.usable ? 1 : 0))),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = await loadManifest();
  const figures = args.limit ? manifest.figures.slice(0, args.limit) : manifest.figures;

  console.log(`基准数据集: ${manifest.name}`);
  console.log(`图幅总数: ${manifest.figures.length}，本次运行: ${figures.length}`);
  console.log(`模型: ${args.provider}/${args.model}`);

  const snapshot = loadPilotConfig({ env: process.env });
  const modelRuntime = createModelRuntime(snapshot.config.model);
  const tool = createAnalyzePatentFigureTool({ provider: args.provider, model: args.model });
  const context = createToolContext(BENCHMARK_DIR, modelRuntime);

  const runStart = performance.now();
  const results: FigureResult[] = [];
  for (let i = 0; i < figures.length; i++) {
    const figure = figures[i];
    console.log(`[${i + 1}/${figures.length}] ${figure.id} — ${figure.title}`);
    const result = await runFigure(figure, tool, context);
    results.push(result);
    const status = result.error ? `❌ ${result.error}` : `✅ ${result.metrics.predictedRefCount} 个标号`;
    console.log(
      `      ${status} | type=${result.predicted?.figureType ?? "—"} | conf=${result.metrics.confidence.toFixed(2)} | ${result.durationMs}ms`,
    );
  }
  const runDurationMs = Math.round(performance.now() - runStart);

  const summary = summarize(results);
  const run: BenchmarkRun = {
    runAt: new Date().toISOString(),
    provider: args.provider,
    model: args.model,
    durationMs: runDurationMs,
    summary,
    results,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  const resultPath = path.join(RESULTS_DIR, `run-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify(run, null, 2));

  console.log("\n=== 汇总 ===");
  console.log(`总计: ${summary.total} | 成功: ${summary.success} | 失败: ${summary.failed}`);
  console.log(`附图类型准确率: ${(summary.typeAccuracy * 100).toFixed(1)}%`);
  console.log(`平均标号精确率: ${(summary.avgRefPrecision * 100).toFixed(1)}%`);
  console.log(`平均标号召回率: ${(summary.avgRefRecall * 100).toFixed(1)}%`);
  console.log(`平均标号 F1: ${(summary.avgRefF1 * 100).toFixed(1)}%`);
  console.log(`平均置信度: ${(summary.avgConfidence * 100).toFixed(1)}%`);
  console.log(`usable 率: ${(summary.usableRate * 100).toFixed(1)}%`);
  console.log(`总耗时: ${runDurationMs}ms`);
  console.log(`结果已保存: ${resultPath}`);
}

main().catch((error: unknown) => {
  console.error("基准运行失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
