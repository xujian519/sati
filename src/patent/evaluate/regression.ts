/**
 * src/patent/evaluate — 专利代理回归评测（P0-2）。
 *
 * 复用既有 Evaluator/CaseRunner/GraphRunner/scoreboard 框架，补三块粘合：
 * - {@link loadRegressionCases}：把 benchmark 目录（statement.md + expected.md +
 *   case.yaml）装载为 EvalCase[]，与自进化闭环（evolve.ts）的 statement/rubric
 *   分离并存——本路径面向"prompt/技能改动的确定性回归"，用 expected 参考文本 +
 *   规则门打分，而非私有 rubric 的 LLM judge；
 * - {@link createProviderFromModelRuntime}：把任意 ModelRuntime（**llm-replay 录制
 *   回放** 或测试脚本运行时）包装为原子图执行所需的 StageProvider.callLLM，走重放
 *   seam 而非真实网络（对齐"单测 mock 外部网络"规范）；
 * - {@link batchReportToScoreboardRecord}：Evaluator 的 BatchReport → ScoreboardRecord。
 *
 * 目标执行 = 领域子图自动执行（复用 createGraphRunner，provider 由回放运行时装配）。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../model/index.js";
import type { StageProvider } from "../atoms/index.js";
import type { BenchmarkConfig, BenchmarkPaths } from "./benchmark.js";
import type { BatchReport, CaseRunner, EvalCase } from "./evaluator.js";
import { parseRubric, type Rubric } from "./rubric.js";
import { createGraphRunner, defaultDomainGraphMap } from "./runner.js";
import type { ScoreboardRecord } from "./scoreboard.js";

/** benchmark_config 声明的评测运行时默认值（case.yaml 未覆盖时）。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** 回归用例 = EvalCase + 私有 rubric（供 LLM judge 侧；生成侧不可见）。 */
export type RegressionCase = EvalCase & { rubric?: Rubric };

/**
 * 装载回归用例：每个 case 目录须有 statement.md（输入）+ expected.md（参考产出）；
 * 可选 case.yaml（domain / businessTask / requiredCitations）与 rubric.yaml（私有
 * 评分标准，parse 非法时忽略并警告——回归主路径不依赖 rubric）。缺 statement/expected
 * 的目录跳过。
 */
export async function loadRegressionCases(paths: BenchmarkPaths): Promise<RegressionCase[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const cases: RegressionCase[] = [];
  for (const name of entries.sort()) {
    const dir = paths.caseDir(name);
    let input: string;
    let expected: string;
    try {
      input = await readFile(join(dir, "statement.md"), "utf8");
      expected = await readFile(join(dir, "expected.md"), "utf8");
    } catch {
      continue; // 非用例目录（config/snapshots/scoreboard 等同级项）
    }
    const meta = await readCaseMeta(join(dir, "case.yaml"));
    const rubric = await readRubric(join(dir, "rubric.yaml"));
    cases.push({
      id: name,
      domain: meta.domain ?? inferDomain(name, input),
      input,
      expected,
      ...(meta.businessTask !== undefined ? { businessTask: meta.businessTask } : {}),
      ...(meta.requiredCitations !== undefined ? { requiredCitations: meta.requiredCitations } : {}),
      ...(rubric !== undefined ? { rubric } : {}),
    });
  }
  return cases;
}

type CaseMeta = { domain?: string; businessTask?: string; requiredCitations?: string[] };

/** 读私有 rubric（缺失/非法返回 undefined，回归主路径不依赖它）。 */
async function readRubric(file: string): Promise<Rubric | undefined> {
  try {
    const result = parseRubric(await readFile(file, "utf8"));
    return result.rubric ?? undefined;
  } catch {
    // rubric 文件缺失（ENOENT）：回归主路径不依赖它，视为无私有评分标准。
    return undefined;
  }
}

async function readCaseMeta(file: string): Promise<CaseMeta> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // case.yaml 缺失：用推断默认值（domain 由 inferDomain、无 businessTask/requiredCitations）。
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    // case.yaml 非法 YAML：同样回退推断默认，不因元数据损坏阻断整批装载。
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const raw = parsed as Record<string, unknown>;
  const meta: CaseMeta = {};
  if (typeof raw.domain === "string") meta.domain = raw.domain;
  if (typeof raw.businessTask === "string") meta.businessTask = raw.businessTask;
  if (Array.isArray(raw.requiredCitations)) {
    meta.requiredCitations = raw.requiredCitations.filter((x): x is string => typeof x === "string");
  }
  return meta;
}

/** case.yaml 缺 domain 时的启发式推断（按用例 id 关键词）。 */
function inferDomain(caseId: string, statement: string): string {
  const hay = `${caseId} ${statement}`.toLowerCase();
  if (hay.includes("novelty") || hay.includes("新颖") || hay.includes("查新")) return "novelty";
  if (hay.includes("invent") || hay.includes("创造") || hay.includes("三步法")) return "inventiveness";
  if (hay.includes("a26.3") || hay.includes("充分公开") || hay.includes("enablement") || hay.includes("disclosure"))
    return "enablement";
  if (hay.includes("oa") || hay.includes("审查意见") || hay.includes("答复")) return "office-action";
  if (hay.includes("claim") || hay.includes("权利要求") || hay.includes("撰写") || hay.includes("draft"))
    return "drafting";
  return "general";
}

/** createProviderFromModelRuntime 选项。 */
export type ProviderFromRuntimeOptions = {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  /** 检索器注入（回放/脚本运行时无真实检索；缺省时依赖 search 的原子阶段降级）。 */
  search?: StageProvider["search"];
  /** 案例标识（透出 claim-chart 等原子落盘/合并）。 */
  caseId?: string;
};

/**
 * 把 ModelRuntime（llm-replay 回放运行时，或测试脚本运行时）包装为 StageProvider。
 * callLLM 单轮发送 prompt 并收集 text_delta；error 事件抛出（回放未命中会 fail-loud
 * NO_REPLAY_RECORD，由上层评测捕获）。
 */
export function createProviderFromModelRuntime(runtime: ModelRuntime, opts: ProviderFromRuntimeOptions): StageProvider {
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return {
    caseId: opts.caseId,
    ...(opts.search !== undefined ? { search: opts.search } : {}),
    callLLM: async (prompt, callOpts) => {
      const request: CanonicalModelRequest = {
        provider: opts.provider,
        model: opts.model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        maxOutputTokens,
        temperature: callOpts?.temperature ?? 0,
        stream: true,
        metadata: { tool: "patent-agent-eval", caseId: opts.caseId ?? "" },
        ...(callOpts?.jsonSchema !== undefined
          ? {
              outputSchema: {
                name: "structured_output",
                schema: callOpts.jsonSchema as Record<string, unknown>,
                strict: true,
              },
            }
          : {}),
      };
      let text = "";
      for await (const event of runtime.stream(request) as AsyncIterable<CanonicalModelEvent>) {
        if (event.type === "text_delta") text += event.text;
        else if (event.type === "error") throw new Error(event.error?.message ?? "模型调用失败");
      }
      return text;
    },
  };
}

/**
 * 回归 CaseRunner：已映射领域子图的用例走图引擎自动执行（createGraphRunner）；
 * 未映射用例（撰写/OA 等未建图域）先由 provider 生成一份产出再过规则门。
 * 图 Runner 的 fallback 把入参直接当 LLM 输出，而回归入参是题目不是答案，
 * 故必须补生成步。生成失败降级为空产出 + degraded 标记（不阻断批次）。
 */
export function createRegressionRunner(provider: StageProvider): CaseRunner {
  const graphRunner = createGraphRunner({ provider });
  return async (input, caseMeta) => {
    if (defaultDomainGraphMap(caseMeta) !== undefined) {
      return graphRunner(input, caseMeta);
    }
    const system =
      "你是资深专利代理师。请针对下述任务产出专业、结构完整、可直接复核的中文交付物（含法条引用与逐特征对比 where applicable）。\n\n【任务】\n";
    let output = "";
    let degraded = false;
    try {
      output = (await provider.callLLM?.(system + input)) ?? "";
    } catch {
      // 生成失败（回放未命中/provider 缺失）：空产出置 degraded，不抛出以中断批次。
      degraded = true;
    }
    const fallback = await graphRunner(output, caseMeta);
    return { ...fallback, degraded: degraded || fallback.degraded };
  };
}

/** BatchReport → ScoreboardRecord（0..1 指标均值缩放到 0..100）。 */
export function batchReportToScoreboardRecord(
  report: BatchReport,
  config: BenchmarkConfig,
  version: number,
  now: () => Date = () => new Date(),
): ScoreboardRecord {
  const perCase = report.cases.map(o => {
    const names = Object.keys(o.metrics);
    const avg01 = names.length > 0 ? names.reduce((a, n) => a + (o.metrics[n] ?? 0), 0) / names.length : 0;
    return {
      case: o.caseId,
      score: round2(avg01 * 100),
      runs: [
        {
          score: round2(avg01 * 100),
          cost: null,
          duration_ms: Math.round(o.elapsedMs),
          session_id: `eval-${o.caseId}`,
        },
      ],
    };
  });
  const overall = perCase.length > 0 ? perCase.reduce((a, c) => a + c.score, 0) / perCase.length : 0;
  return {
    time: now().toISOString(),
    version,
    provider: config.eval_runtime.provider,
    model_id: config.eval_runtime.model_id,
    thinking_level: config.eval_runtime.thinking_level,
    score: round2(overall),
    cost: null,
    duration_ms: Math.round(report.cases.reduce((a, c) => a + c.elapsedMs, 0) / Math.max(1, report.cases.length)),
    cases: perCase,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
