#!/usr/bin/env node
/**
 * patent-eval —— 专利业务评测脚本：真实 LLM 生成 + 确定性规则门（checker）收口。
 *
 * 用途：对 tests/patent/benchmark/fixtures/ 下的评测用例（如 patent-exam-real-a26-3.json，
 * 含 2011/2012 专利代理人考试真题与无效决定案例）做端到端评测：
 *   1. 每个 case 调用真实 LLM（默认 deepseek/deepseek-v4-pro）生成分析；
 *   2. 可选注入领域知识（所属领域技术人员定义 + 领域差异原则 + 法律标准，
 *      提炼自 src/knowledge/patent/ 知识卡片与审查指南第二部分第二章 2.1.3）与
 *      维度覆盖指令（清楚/完整/能够实现 + 实验数据等辅助维度的适用性）；
 *   3. 产出经 defaultPatentRules 按检查域收口（runRuleGate），输出判级与失败明细；
 *   4. 控制台打印结论摘要 + 规则门判定，完整产出落盘 JSON 供人工评审。
 *
 * 前置：pnpm build（脚本依赖 dist/ 编译产物）。
 *
 * 用法：
 *   node scripts/patent-eval.mjs [--suite <fixture.json>] [--model <provider/model>]
 *       [--no-knowledge] [--no-dimension-instruction] [--check-domain <domain>]
 *       [--out <output.json>] [--max-cases <N>]
 *
 * 示例：
 *   node scripts/patent-eval.mjs                                      # A26.3 全套（知识注入）
 *   node scripts/patent-eval.mjs --no-knowledge                       # 基线对照（无知识注入）
 *   node scripts/patent-eval.mjs --model deepseek/deepseek-v4-flash   # 换模型
 *   node scripts/patent-eval.mjs --suite tests/patent/benchmark/fixtures/patent-exam-real-a22.json \
 *       --check-domain patent_novelty                                 # 换 suite 与检查域
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPilotConfig } from "../dist/src/pilot/index.js";
import { createModelRuntime } from "../dist/src/model/index.js";
import { runRuleGate } from "../dist/src/tool/builtin/patentWorkflowTool.js";
import { createGraphRunner, Evaluator } from "../dist/src/patent/evaluate/index.js";
import { createNuoSearchProvider } from "../dist/src/patent/data/nuo/searchProvider.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 领域知识包（提炼自 src/knowledge/patent/ 知识卡片与审查指南第二部分第二章 2.1.3）
// ---------------------------------------------------------------------------
const KNOWLEDGE = `【所属领域技术人员（来源：专利知识卡片）】
"所属领域技术人员"是假定的"人"：知晓申请日或优先权日之前发明所属技术领域所有的普通技术知识，能够获知该领域中所有的现有技术，具备常规实验的手段和能力，但不具有创造能力。本领域技术人员能够利用其普通技术知识补充说明书未明确记载的常规内容。

【领域差异原则（来源：审查指南第二部分第二章 2.1.3 实务标准）】
"能够实现"是相对标准，须结合技术领域判断：
- 机械结构类发明/实用新型：常规部件的选型、连接方式、传动方式（如电机驱动、齿轮/丝杆传动、管道连接、装配关系）属于本领域技术人员的普通技术知识。说明书给出完整部件组成、功能配合并配有附图时，通常即满足充分公开；不要求逐部件公开详细设计尺寸或全部结构细节。
- 化学/医药类发明：技术效果依赖实验数据验证，缺少实验数据或测试方法可能构成公开不充分。
- 电子/半导体类：常规模块（传感器、通信、供电、封装间隔结构如间隔柱/凸块等）及其连接属于本领域普通技术知识；功能性描述若对应本领域公知的实现方式，不当然构成公开不充分；但若某功能依赖前沿技术且无任何实现手段记载，则可能构成公开不充分。
- 不得把某一领域（尤其是化学/医药对实验数据的严苛要求）的审查标准迁移到其他领域。

【法律标准】
专利法第26条第3款：说明书应当对发明或者实用新型作出清楚、完整的说明，以所属技术领域的技术人员能够实现为准。`;

/** 维度覆盖指令：知识注入可能引导 LLM 注意力偏移，需显式要求覆盖全部审查维度。 */
const DIMENSION_INSTRUCTION = `请在你的分析中显式覆盖以下审查维度：
① 清楚性；② 完整性；③ 能够实现性；④ 实验数据等辅助维度的适用性（若本案不涉及实验数据要求，请显式说明理由）。`;

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`用法: node scripts/patent-eval.mjs [options]
  --suite <path>                评测用例 JSON（默认 tests/patent/benchmark/fixtures/patent-exam-real-a26-3.json）
  --model <provider/model>      LLM（默认 deepseek/deepseek-v4-pro）
  --mode <text|graph>           评测模式：text=单文本+规则门（默认）；graph=领域子图自动执行（图引擎）
  --no-knowledge                关闭领域知识注入（基线对照；仅 text 模式）
  --no-dimension-instruction    关闭维度覆盖指令（仅 text 模式）
  --check-domain <domain>       规则门检查域，逗号分隔（默认 patent_disclosure；text 模式）
  --out <path>                  完整产出 JSON 保存路径（默认 /tmp/patent-eval-outputs.json）
  --max-cases <N>               最多评测前 N 个 case（默认全部）
  -h, --help                    显示本帮助`);
}

function parseArgs(argv) {
  const opts = {
    suite: "tests/patent/benchmark/fixtures/patent-exam-real-a26-3.json",
    model: "deepseek/deepseek-v4-pro",
    mode: "text",
    knowledge: true,
    dimensionInstruction: true,
    checkDomain: "patent_disclosure",
    out: "/tmp/patent-eval-outputs.json",
    maxCases: Infinity,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--suite":
        opts.suite = argv[++i];
        break;
      case "--model":
        opts.model = argv[++i];
        break;
      case "--mode":
        opts.mode = argv[++i];
        break;
      case "--no-knowledge":
        opts.knowledge = false;
        break;
      case "--no-dimension-instruction":
        opts.dimensionInstruction = false;
        break;
      case "--check-domain":
        opts.checkDomain = argv[++i];
        break;
      case "--out":
        opts.out = argv[++i];
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.maxCases < 1) opts.maxCases = Infinity;

  if (!existsSync(resolve(ROOT, "dist/src/pilot/index.js"))) {
    console.error("dist/ 编译产物不存在，请先执行 pnpm build。");
    process.exit(1);
  }

  const snapshot = loadPilotConfig();
  const runtime = createModelRuntime(snapshot.config.model);
  const slash = opts.model.indexOf("/");
  if (slash < 1) {
    console.error(`--model 格式应为 provider/model，收到: ${opts.model}`);
    process.exit(1);
  }
  const provider = opts.model.slice(0, slash);
  const model = opts.model.slice(slash + 1);

  const fixturePath = resolve(ROOT, opts.suite);
  if (!existsSync(fixturePath)) {
    console.error(`fixture 不存在: ${fixturePath}`);
    process.exit(1);
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const cases = Array.isArray(fixture) ? fixture : (fixture.cases ?? []);
  const targets = cases.slice(0, opts.maxCases);
  if (targets.length === 0) {
    console.error(`fixture 无 case（suite=${fixture.suite ?? "?"}）`);
    process.exit(1);
  }

  // 图模式：领域子图自动执行（三性）→ 规则门 + expected 指标（Evaluator 汇总）。
  if (opts.mode === "graph") {
    const provider = {
      callLLM: async (prompt, callOpts) => {
        const res = await runtime.complete({
          provider,
          model,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          maxOutputTokens: 4096,
          temperature: callOpts?.temperature ?? 0,
          ...(callOpts?.jsonSchema
            ? { outputSchema: { name: "structured_output", schema: callOpts.jsonSchema, strict: true } }
            : {}),
        });
        return res.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n");
      },
      search: createNuoSearchProvider().search,
    };
    const runner = createGraphRunner({ provider });
    const evaluator = new Evaluator(runner, { passLine: 0.5 });
    const evalCases = targets.map(c => ({
      id: c.id,
      domain: c.domain ?? "patent",
      input: c.input,
      expected: c.expected ?? "",
      requiredCitations: c.requiredCitations,
      businessTask: c.businessTask,
    }));
    console.log(
      `[评测·图] fixture=${opts.suite} | 模型=${opts.model} | cases=${evalCases.length} | 模式=领域子图自动执行`,
    );
    const report = await evaluator.evaluateCases(evalCases);
    console.log(`[结果] total=${report.total} passed=${report.passed} degraded=${report.degradedCount}`);
    console.log(`[指标] ${JSON.stringify(report.metrics, null, 2)}`);
    for (const o of report.cases) {
      const gate = o.ruleGateFailures.length === 0 ? "pass" : `fail(${o.ruleGateFailures.length})`;
      console.log(`  ${o.caseId}: verdict=${o.verdict} gate=${gate} degraded=${o.degraded} ${o.elapsedMs}ms`);
    }
    writeFileSync(opts.out, JSON.stringify(report, null, 2));
    console.log(`产出已写入: ${opts.out}`);
    return;
  }

  const systemPrompt = [
    ...(opts.knowledge ? [KNOWLEDGE] : []),
    "请以专利审查员身份，严格依据上述知识与专利法第26条第3款，对该案作出判断。",
    ...(opts.dimensionInstruction ? [DIMENSION_INSTRUCTION] : []),
  ].join("\n\n");

  console.log(
    `[评测] fixture=${opts.suite} | 模型=${opts.model} | cases=${targets.length}` +
      ` | 知识注入=${opts.knowledge ? "开" : "关"} | 维度指令=${opts.dimensionInstruction ? "开" : "关"}` +
      ` | 检查域=${opts.checkDomain}`,
  );

  const results = [];
  for (const c of targets) {
    const t0 = Date.now();
    let text = "";
    try {
      const res = await runtime.complete({
        provider,
        model,
        systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: c.input }] }],
        temperature: 0.2,
        maxOutputTokens: 3000,
      });
      text = res.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    } catch (err) {
      console.log(`[ERR] ${c.id} — ${err instanceof Error ? err.message : String(err)}`);
      results.push({ id: c.id, error: String(err) });
      continue;
    }

    const gate = runRuleGate(
      { stages: [{ degraded: false, output: text }] },
      opts.checkDomain
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),
    );
    results.push({
      id: c.id,
      elapsedSec: ((Date.now() - t0) / 1000).toFixed(1),
      ruleGate: gate.split("\n")[0],
      ruleGateDetail: gate,
      conclusion:
        text
          .split("\n")
          .filter(l => /结论|综合判断/.test(l))
          .slice(-1)[0]
          ?.slice(0, 200) ?? text.slice(0, 120),
      output: text,
    });
    console.log(`[ok] ${c.id} — ${results.at(-1).elapsedSec}s | ${results.at(-1).ruleGate}`);
  }

  writeFileSync(
    opts.out,
    JSON.stringify(
      results.map(r => ({ id: r.id, output: r.output })),
      null,
      2,
    ),
  );
  console.log(`\n完整产出已写入 ${opts.out}\n`);

  console.log("=".repeat(80));
  console.log("评测汇总");
  console.log("=".repeat(80));
  let pass = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`\n■ ${r.id} — ERROR: ${r.error}`);
      continue;
    }
    if (/✅ 通过/.test(r.ruleGate)) pass += 1;
    console.log(`\n■ ${r.id}  [${r.elapsedSec}s]`);
    console.log(`  规则门: ${r.ruleGate}`);
    console.log(`  结论摘要: ${r.conclusion}`);
  }
  console.log(`\n${"-".repeat(80)}`);
  console.log(`规则门通过: ${pass}/${results.length}（失败 case 的规则门明细见 ruleGateDetail 字段）`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
