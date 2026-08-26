#!/usr/bin/env node
/**
 * patent-evolve —— 自进化闭环的「单次评测」CLI（M2：baseline）。
 *
 * 对基准目录下每个 case：statement（公开，喂被测 Agent）→ 生成产出 →
 *   按私有 rubric 判「可观察行为」得分 → 聚合为该版本一条 ScoreboardRecord → 落 scoreboard.yaml。
 *
 * 隔离（statement/rubric 分离）：generate 侧只拿到 statement；rubric 只进入 judge 侧 prompt，
 *   rubric 内容永不流入生成侧。运行时三元组（provider/model_id/thinking_level）取自
 *   benchmark_config.yaml 的 eval_runtime，跨版本可比。
 *
 * 前置：pnpm build（脚本依赖 dist/ 编译产物）。
 *
 * 用法：
 *   node scripts/patent-evolve.mjs --benchmark-root <root> --benchmark-id <id>
 *       [--model <provider/model>] [--judge-model <provider/model>]
 *       [--version <N>] [--max-cases <N>]
 *
 * 示例：
 *   node scripts/patent-evolve.mjs --benchmark-root ~/.sati/benchmarks \
 *       --benchmark-id claims-drafting-quality --model deepseek/deepseek-v4-flash
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPilotConfig } from "../dist/src/pilot/index.js";
import { createModelRuntime } from "../dist/src/model/index.js";
import {
  aggregateRubricScore,
  benchmarkPaths,
  buildJudgePrompt,
  parseBenchmarkConfig,
  parseVerdicts,
  readScoreboard,
  runBaseline,
} from "../dist/src/patent/evaluate/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

const GENERATION_SYSTEM = `你是一名资深专利代理师。请基于用户给出的技术材料与任务要求，产出专业的专利分析文档（如权利要求书撰写方案、审查意见答复、可专利性分析等）。只输出分析正文，不要复述题目，不要输出与任务无关的客套话。`;

const JUDGE_SYSTEM = `你是严格的评测员。根据评分标准，逐条判断被测产出中"可观察行为/缺陷是否发生"，并只输出 JSON 布尔对象。不要输出任何解释、markdown 围栏或多余文字。`;

function printHelp() {
  console.log(`用法: node scripts/patent-evolve.mjs
  --benchmark-root <dir>       benchmarks 根目录（默认 ~/.sati/benchmarks）
  --benchmark-id <id>          基准 id
  --model <provider/model>     生成模型（默认 ${DEFAULT_MODEL}）
  --judge-model <provider/model>  评分模型（默认 = --model）
  --version <N>                本版本号（默认 = scoreboard 最大版本 + 1）
  --max-cases <N>              最多评测前 N 个 case（默认全部）
  -h, --help                   显示本帮助`);
}

function parseArgs(argv) {
  const opts = {
    root: resolve(homedir(), ".sati", "benchmarks"),
    id: undefined,
    model: DEFAULT_MODEL,
    judgeModel: undefined,
    version: undefined,
    maxCases: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--benchmark-root":
        // 相对路径基于当前工作目录；绝对路径保持；`~` 展开为 home。
        opts.root = resolve(argv[++i].replace(/^~/, homedir()));
        break;
      case "--benchmark-id":
        opts.id = argv[++i];
        break;
      case "--model":
        opts.model = argv[++i];
        break;
      case "--judge-model":
        opts.judgeModel = argv[++i];
        break;
      case "--version":
        opts.version = Number(argv[++i]);
        break;
      case "--max-cases":
        opts.maxCases = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`未知参数: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

function splitModel(spec) {
  const slash = spec.indexOf("/");
  if (slash < 1) {
    throw new Error(`--model 格式应为 provider/model，收到: ${spec}`);
  }
  return { provider: spec.slice(0, slash), model_id: spec.slice(slash + 1) };
}

/**
 * 用 ModelRuntime.complete 组装一次 LLM 调用，返回文本内容。
 * thinking off：评测要的是可判分正文，不要模型思考；deepseek-v4/kimi 默认开启思考，
 * 会把最终 content 榨干为空（官方文档：thinking 默认 enabled、reasoning_content 在 final 之前），
 * 显式 off 走 provider 的 off 分支（thinking:{type:"disabled"}）。
 */
function makeCall(runtime, provider, model, systemPrompt, temperature) {
  return async (prompt, maxOutputTokens = 4096) => {
    const res = await runtime.complete({
      provider,
      model,
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      temperature,
      maxOutputTokens,
      thinking: { mode: "off", enabled: false },
    });
    return res.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.id) {
    console.error("需提供 --benchmark-id。");
    printHelp();
    process.exit(1);
  }
  if (!existsSync(resolve(ROOT, "dist/src/patent/evaluate/index.js"))) {
    console.error("dist/ 编译产物不存在，请先执行 pnpm build。");
    process.exit(1);
  }

  const snapshot = loadPilotConfig();
  const runtime = createModelRuntime(snapshot.config.model);
  const genModel = splitModel(opts.model);
  const judgeModel = splitModel(opts.judgeModel ?? opts.model);

  const paths = benchmarkPaths(opts.root, opts.id);
  if (!existsSync(paths.configPath)) {
    console.error(`benchmark_config 不存在: ${paths.configPath}`);
    process.exit(1);
  }
  const configResult = parseBenchmarkConfig(readFileSync(paths.configPath, "utf8"));
  if (configResult.config === null) {
    console.error(`benchmark_config 非法: ${configResult.error}`);
    process.exit(1);
  }
  const config = configResult.config;

  // 版本号：默认 scoreboard 最大 version + 1（首次为 1）。
  const existing = await readScoreboard(paths.scoreboardPath);
  if (existing.error !== null) {
    console.error(`scoreboard 非法: ${existing.error}`);
    process.exit(1);
  }
  const version = opts.version ?? existing.records.reduce((m, r) => Math.max(m, r.version), 0) + 1;

  const genCall = makeCall(runtime, genModel.provider, genModel.model_id, GENERATION_SYSTEM, 0.2);
  const judgeCall = makeCall(runtime, judgeModel.provider, judgeModel.model_id, JUDGE_SYSTEM, 0);

  const result = await runBaseline({
    paths,
    config,
    version,
    maxCases: opts.maxCases,
    generate: async (_systemPrompt, statement) => {
      const t0 = Date.now();
      const text = await genCall(statement, 4096);
      return { text, sessionId: randomUUID(), durationMs: Date.now() - t0 };
    },
    judge: async (statement, output, rubric) => {
      const text = await judgeCall(buildJudgePrompt(statement, output, rubric), 2000);
      const verdicts = parseVerdicts(text, rubric.items);
      return aggregateRubricScore(verdicts, rubric);
    },
  });

  console.log(`[baseline] benchmark=${opts.id} | model=${opts.model} | judge=${opts.judgeModel ?? opts.model}`);
  console.log(`[baseline] version=${version} | cases=${result.casesRun}`);
  console.log(`[baseline] score=${result.record.score} | 明细:`);
  for (const c of result.record.cases) {
    console.log(`  ${c.case}: ${c.score}/${c.runs[0].session_id.slice(0, 8)}…`);
  }
  console.log(`[baseline] scoreboard=${paths.scoreboardPath} (${result.count} 条记录)`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
