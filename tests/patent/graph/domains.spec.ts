import assert from "node:assert/strict";
import test from "node:test";
import { buildSpecContext, runSpecPrechecks, splitSpecSections } from "../../../src/patent/graph/domains/enablement.js";
import {
  StageHandlerRegistry,
  buildEnablementGraph,
  buildInventivenessGraph,
  buildNoveltyGraph,
  detectTechnicalDomain,
  extractEnablementResult,
  extractInventivenessResult,
  extractNumericRanges,
  globalStageHandlerRegistry,
  isDegraded,
  registerBuiltinAtoms,
  type StageHandler,
  type StageProvider,
} from "../../../src/patent/index.js";

registerBuiltinAtoms();

/** 放行 approval-gate 的 handler 注册表（完整测试用）。 */
function passthroughHandlers(): StageHandlerRegistry {
  const passthroughApproval: StageHandler = {
    name: "approval-gate",
    category: "gate",
    execute: async () => ({ review_passed: true }),
  };
  const handlers = new StageHandlerRegistry();
  for (const h of globalStageHandlerRegistry.list()) handlers.register(h);
  handlers.register(passthroughApproval);
  return handlers;
}

// ---------------------------------------------------------------------------
// 确定性节点：extractNumericRanges / detectTechnicalDomain
// ---------------------------------------------------------------------------

test("extractNumericRanges: 检测数值范围/端点/带单位表述", () => {
  const ranges = extractNumericRanges("温度范围为 50-80°C，厚度至少 5mm，速度大于 10m/s，压力 ≤ 2MPa，重量 1.5-2.5kg");
  assert.deepEqual(ranges, ["50-80", "至少 5", "大于 10", "≤ 2", "1.5-2.5"]);
  assert.deepEqual(extractNumericRanges("无任何数值"), []);
});

test("detectTechnicalDomain: 化学/计算机/机械/通用检测", () => {
  assert.equal(detectTechnicalDomain("一种化合物及其制备方法").domain, "chemical");
  assert.equal(detectTechnicalDomain("一种数据处理方法及电子设备").domain, "software");
  assert.equal(detectTechnicalDomain("一种传动装置").domain, "mechanical");
  assert.equal(detectTechnicalDomain("一种日常用品").domain, "generic");
});

// ---------------------------------------------------------------------------
// novelty 子图
// ---------------------------------------------------------------------------

const noveltyProvider = (): StageProvider => ({
  callLLM: async prompt => {
    // 注意：conclude prompt 含"数值范围"标题字样，须先匹配最具体者。
    if (prompt.includes("完整新颖性分析报告")) {
      return "新颖性分析报告：权利要求相对于现有技术 D1 具备新颖性（单独对比原则，逐技术特征比对见附表）。置信度：高。";
    }
    if (prompt.includes("数值范围")) {
      return JSON.stringify({
        assessments: [{ range: "50-80", category: "重叠区间", disclosed: false, reasoning: "端点未公开" }],
      });
    }
    if (prompt.includes("技术分析助手")) {
      return JSON.stringify({ features: ["传送带", "识别传感器"], problems: [], effects: [] });
    }
    if (prompt.includes("检索关键词")) {
      return JSON.stringify({ keywords: ["分拣", "传感器"] });
    }
    if (prompt.includes("新颖性分析专家")) {
      return JSON.stringify({
        assessments: [{ feature: "传送带", prior_art: "D1", disclosed: false, reasoning: "未公开" }],
        conclusion: "具备新颖性（置信度 0.8）",
      });
    }
    return "默认";
  },
  search: async query => [{ title: `文献: ${query}`, snippet: "摘要", url: "https://example.com/1" }],
});

test("novelty: mock provider + 放行审批 → 跑完全图 + 规则门收口", async () => {
  const graph = buildNoveltyGraph({ handlers: passthroughHandlers() }).compile("extract");
  const result = await graph.run(
    {
      text: "一种分拣装置，温度范围为 50-80°C，包含传送带与识别传感器",
      prior_art: [{ title: "D1", snippet: "公开传送带" }],
    },
    { provider: noveltyProvider() },
  );
  assert.equal(result.completed, true);
  assert.ok((result.state.novelty_report as string).includes("新颖性分析报告"));
  assert.deepEqual(result.state.numeric_ranges, ["50-80"]);
  // 规则门收口：verdict 输出存在（patent_novelty 域含优先权/公开方式/推理模式规则，
  // mock 报告未覆盖 → blocked 属预期；核心通过性由 ruleGate:false 用例验证）。
  assert.ok(["pass", "blocked", "needs_revision"].includes(result.state.rule_gate_verdict as string));
  assert.ok(Array.isArray(result.state.rule_gate_failures));
});

test("novelty: 无 provider → LLM 节点降级 + approval 中断", async () => {
  const graph = buildNoveltyGraph({ handlers: globalStageHandlerRegistry }).compile("extract");
  const result = await graph.run({ text: "一种分拣装置" });
  assert.equal(result.completed, false);
  assert.equal(result.interrupted?.node, "approval");
  // extract/compare/conclude 等 LLM 节点降级（有降级标记；outputKey 为 novelty_report）。
  assert.equal(isDegraded(result.state, "novelty_report"), true);
  assert.equal(result.degraded.length >= 1, true);
});

test("novelty: includeApproval=false → 无审批门，conclude 直达 END（可完整跑完）", async () => {
  const graph = buildNoveltyGraph({
    ruleGate: false,
    includeApproval: false,
    handlers: globalStageHandlerRegistry,
  }).compile("extract");
  const desc = graph.describe();
  assert.ok(!desc.nodes.includes("approval"));
  assert.ok(!desc.nodes.includes("rule_gate"));
  // 无审批：LLM 节点降级后仍直达 END，completed=true（自动执行语义）。
  const result = await graph.run({ text: "一种分拣装置" });
  assert.equal(result.completed, true);
});

// ---------------------------------------------------------------------------
// inventiveness 子图
// ---------------------------------------------------------------------------

const inventivenessProvider = (): StageProvider => ({
  callLLM: async prompt => {
    if (prompt.includes("三步法第一步")) {
      return JSON.stringify({
        document: "D1",
        technical_field: "机械分拣",
        disclosed_features: ["传送带"],
        rationale: "技术领域相同且公开特征最多",
      });
    }
    if (prompt.includes("三步法第二步")) {
      return JSON.stringify({
        distinguishing_features: ["识别传感器"],
        actual_technical_problem: "如何自动识别分拣目标",
        effect_of_diff: "提高分拣准确率",
      });
    }
    if (prompt.includes("是否存在可与最接近现有技术")) {
      return JSON.stringify({
        candidate_documents: ["D2"],
        combinable: false,
        motivation: "D2 无结合启示",
        obstacles: ["结构不兼容"],
        teaching_away: true,
      });
    }
    if (prompt.includes("三步法第三步")) {
      return JSON.stringify({
        obvious: false,
        motivation: "D1 无结合启示",
        evidence: [],
        dissenting_factors: ["D2 反向教导"],
      });
    }
    if (prompt.includes("辅助判断因素")) {
      return JSON.stringify({
        unexpected_effect: "准确率提升 30%",
        long_felt_need: "",
        technical_prejudice: "",
        commercial_success: "",
      });
    }
    if (prompt.includes("综合三步法")) {
      return JSON.stringify({
        inventive: true,
        confidence: "medium",
        key_rationale: "区别特征带来预料不到的技术效果",
        report:
          "三步法分析报告：D1 为最接近现有技术，区别特征为识别传感器，D1/D2 无结合启示，对本领域技术人员而言并非显而易见，具备创造性。",
      });
    }
    if (prompt.includes("覆盖度")) {
      return JSON.stringify({ adequate: true, covered_features: ["传送带", "识别传感器"], missing_features: [] });
    }
    if (prompt.includes("创造性分析专家")) {
      return JSON.stringify({
        features: ["传送带", "识别传感器"],
        field: "机械分拣",
        filing_date: "2024-01-01",
        inventor_claimed_effect: "提高分拣准确率",
      });
    }
    if (prompt.includes("检索策略")) {
      return "检索策略：1) 分拣 AND 传感器；2) 传送带 AND 识别；3) IPC B07C";
    }
    return "默认";
  },
  search: async query => [
    { title: `文献: ${query}`, snippet: "摘要", url: "https://example.com/1", publication_date: "2023-01-15" },
  ],
});

test("inventiveness: mock provider → 三步法全流程 + 结论提取（ruleGate 关闭）", async () => {
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run(
    { text: "一种分拣装置，包括传送带与识别传感器" },
    { provider: inventivenessProvider() },
  );
  assert.equal(result.completed, true);
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true);
  assert.equal(extracted.confidence, "medium");
  assert.ok(extracted.report?.includes("三步法"));
});

test("inventiveness: 规则门收口输出 verdict（推理路径规则严格，blocked/needs_revision 可接受）", async () => {
  const graph = buildInventivenessGraph({ handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run(
    { text: "一种分拣装置，包括传送带与识别传感器" },
    { provider: inventivenessProvider() },
  );
  assert.equal(result.completed, true);
  assert.ok(["pass", "blocked", "needs_revision"].includes(result.state.rule_gate_verdict as string));
  assert.ok(Array.isArray(result.state.rule_gate_failures));
});

test("inventiveness: closest 提示可见候选公开日与时间基准要求（P0-3）", async () => {
  let closestPrompt = "";
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("三步法第一步")) closestPrompt = prompt;
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.ok(closestPrompt.includes("publication_date"), "closest prompt 应要求逐篇标注公开日");
  assert.ok(closestPrompt.includes("2023-01-15"), "closest prompt 应包含检索命中的公开日值");
});

test("inventiveness: 无 provider → 全 LLM 节点降级 + approval 中断", async () => {
  const graph = buildInventivenessGraph({ handlers: globalStageHandlerRegistry }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置" });
  assert.equal(result.completed, false);
  assert.equal(result.interrupted?.node, "approval");
  assert.equal(isDegraded(result.state, "inventiveness_conclusion"), true);
});

// ---------------------------------------------------------------------------
// enablement 子图
// ---------------------------------------------------------------------------

const enablementProvider = (): StageProvider => ({
  callLLM: async prompt => {
    // 注意：conclude prompt 含"结构完整性"等标题字样，须先匹配最具体者。
    if (prompt.includes("充分公开审查报告")) {
      return JSON.stringify({
        sufficiently_disclosed: false,
        confidence: "medium",
        key_rationale: "缺少实施例与实验数据",
        report: "A26.3 审查报告：说明书未充分公开，缺少实施例，本领域技术人员无法实现。",
      });
    }
    if (prompt.includes("结构完整性")) {
      return JSON.stringify({
        missing_sections: ["附图说明"],
        completeness_ok: false,
        notes: "缺少附图说明章节",
      });
    }
    if (prompt.includes("清楚性")) {
      return JSON.stringify({
        issues: [{ problem: "术语未定义", location: "发明内容", severity: "major" }],
        clarity_ok: false,
      });
    }
    if (prompt.includes("能够实现性")) {
      return JSON.stringify({
        gaps: ["未给出实施例参数"],
        enablement_ok: false,
        skilled_person_assessment: "无法实现",
      });
    }
    return "默认";
  },
});

test("enablement: mock provider → A26.3 全流程 + 领域规则 + 规则门", async () => {
  const graph = buildEnablementGraph({ handlers: passthroughHandlers() }).compile("load");
  const result = await graph.run(
    {
      text: "一种化合物及其制备方法。技术领域：化学。背景技术…发明内容…具体实施方式…附图说明…实施例1：制备 50-80°C。",
    },
    { provider: enablementProvider() },
  );
  assert.equal(result.completed, true);
  assert.equal(result.state.technical_domain, "chemical");
  assert.ok(Array.isArray(result.state.domain_requirements) && result.state.domain_requirements.length > 0);
  const extracted = extractEnablementResult(result.state);
  assert.equal(extracted.sufficientlyDisclosed, false);
  assert.equal(result.state.rule_gate_verdict, "pass");
});

test("enablement: load 节点确定性结构检查", async () => {
  const graph = buildEnablementGraph({ handlers: globalStageHandlerRegistry }).compile("load");
  const result = await graph.run({ text: "技术领域…具体实施方式…" }, { provider: enablementProvider() });
  // 无 approval 放行 → 会中断，但 load/completeness 等已执行。
  assert.equal(result.completed, false);
  assert.deepEqual(result.state.spec_sections_present, ["技术领域", "具体实施方式"]);
  const missing = result.state.spec_sections_missing;
  assert.ok(Array.isArray(missing) && missing.includes("背景技术"));
});

test("splitSpecSections: 标准五部分切分（含摘要与 preamble）", () => {
  const text = [
    "一种装置",
    "技术领域",
    "本发明涉及……",
    "背景技术",
    "现有技术……",
    "发明内容",
    "技术方案……",
    "附图说明",
    "图1……",
    "具体实施方式",
    "实施例1：……",
    "摘要",
    "本申请公开……",
  ].join("\n");
  const sections = splitSpecSections(text);
  assert.ok(sections["技术领域"]!.includes("本发明涉及"));
  assert.ok(sections["具体实施方式"]!.includes("实施例1"));
  assert.ok(sections["摘要"]!.includes("本申请公开"));
  assert.ok(sections.preamble!.includes("一种装置"));
});

test("splitSpecSections: 带编号/【】标题与无标题 fallback", () => {
  const numbered = "1. 技术领域\n内容A\n【发明内容】\n内容B\n";
  const s1 = splitSpecSections(numbered);
  assert.ok(s1["技术领域"]!.includes("内容A"));
  assert.ok(s1["发明内容"]!.includes("内容B"));
  assert.deepEqual(splitSpecSections("无任何标题的纯文本"), { full: "无任何标题的纯文本" });
});

test("buildSpecContext: 优先章节在前、预算内截断、无切片回退全文", () => {
  const state = {
    spec_section_texts: { 具体实施方式: "E".repeat(6000), 发明内容: "C".repeat(4000), 背景技术: "B" },
    text: "全文",
  };
  const ctx = buildSpecContext(state, ["具体实施方式", "发明内容"], 8000);
  assert.ok(ctx.startsWith("## 具体实施方式"), "优先章节应在前");
  assert.ok(ctx.length <= 8000 + 100, "预算内截断");
  const fallback = buildSpecContext({ text: "ABCDEFG" }, ["具体实施方式"], 5);
  assert.equal(fallback, "ABCDE");
});

test("runSpecPrechecks: 实施例计数/数值范围端点/效果定量", () => {
  const ok = runSpecPrechecks("实施例1：温度为 20-90℃，实施例2：温度为 20℃，实施例3：温度为 90℃，效果显著提高 30%");
  assert.equal(ok.has_embodiment, true);
  assert.ok(ok.embodiment_count >= 3);
  assert.deepEqual(ok.numeric_range_endpoint_missing, []);
  assert.deepEqual(ok.numeric_range_midpoint_missing, ["20-90℃"]);
  const missing = runSpecPrechecks("实施例1：温度为 20-90℃。效果好。");
  assert.deepEqual(missing.numeric_range_endpoint_missing, ["20-90℃"]);
  assert.ok(missing.vague_effect_sentences.some(s => s.includes("效果好")));
  assert.equal(runSpecPrechecks("仅给出技术方案描述，未记载任何实施示例").has_embodiment, false);
});

test("enablement: 五情形与平衡条件进入 prompt（§2.1.3 全覆盖）+ claim 注入", async () => {
  const prompts: string[] = [];
  const provider: StageProvider = {
    callLLM: async prompt => {
      prompts.push(prompt);
      if (prompt.includes("充分公开审查报告")) {
        return JSON.stringify({
          sufficiently_disclosed: true,
          confidence: "high",
          key_rationale: "ok",
          report: "充分公开审查报告：说明书清楚完整，本领域技术人员能够实现。",
        });
      }
      if (prompt.includes("结构完整性")) {
        return JSON.stringify({ missing_sections: [], completeness_ok: true, notes: "ok" });
      }
      if (prompt.includes("清楚性")) {
        return JSON.stringify({ issues: [], clarity_ok: true });
      }
      if (prompt.includes("能够实现性")) {
        return JSON.stringify({ gaps: [], enablement_ok: true, skilled_person_assessment: "可实现" });
      }
      return "默认";
    },
  };
  const graph = buildEnablementGraph({ handlers: passthroughHandlers() }).compile("load");
  await graph.run(
    { text: "技术领域：化学。发明内容：…。具体实施方式：实施例1…", claim: "1. 一种化合物…" },
    { provider },
  );
  const enablementPrompt = prompts.find(p => p.includes("第三步：能够实现性")) ?? "";
  for (const clause of [
    "(1) 只给出任务",
    "(2) 给出了技术手段但含糊不清",
    "(3) 给出了技术手段但不能解决",
    "(4) 方案由多个技术手段构成",
    "(5) 需实验证据证实",
  ]) {
    assert.ok(enablementPrompt.includes(clause), `缺少 §2.1.3 情形: ${clause}`);
  }
  for (const balance of ["公知常识", "至少解决一个技术问题", "效果夸大通常不构成"]) {
    assert.ok(enablementPrompt.includes(balance), `缺少平衡条件: ${balance}`);
  }
  assert.ok(enablementPrompt.includes("1. 一种化合物…"), "权利要求应注入 enablement prompt");
  assert.ok(enablementPrompt.includes("判断对象"), "应声明判断对象为权利要求");
});

// ---------------------------------------------------------------------------
// inventiveness 检索反思回路（P0-1）
// ---------------------------------------------------------------------------

test("inventiveness: 检索反思回路——首轮覆盖不足触发第二次检索，prior_art 为两轮去重并集（P0-1）", async () => {
  const searches: string[] = [];
  const base = inventivenessProvider();
  let recallCalls = 0;
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("覆盖度")) {
        recallCalls += 1;
        if (recallCalls === 1) {
          return JSON.stringify({
            adequate: false,
            covered_features: ["传送带"],
            missing_features: ["识别传感器"],
          });
        }
        return JSON.stringify({ adequate: true, covered_features: ["传送带", "识别传感器"], missing_features: [] });
      }
      return base.callLLM!(prompt);
    },
    search: async query => {
      searches.push(query);
      if (searches.length === 1) {
        return [{ title: "D1 传送带", snippet: "公开传送带", url: "u1", publication_date: "2022-01-01" }];
      }
      return [{ title: "D2 识别传感器", snippet: "公开识别传感器", url: "u2", publication_date: "2022-06-01" }];
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(searches.length, 2, "应触发第二次检索");
  assert.ok(searches[1]!.includes("识别传感器"), `补检索式应含缺特征: ${searches[1]}`);
  const priorArt = result.state.prior_art as Array<Record<string, unknown>>;
  assert.equal(priorArt.length, 2, "两轮结果并集去重");
  assert.ok(
    priorArt.some(d => d.title === "D2 识别传感器"),
    "并集应含第二轮新增文献",
  );
  assert.equal(result.state.inventiveness_recall_exhausted, undefined, "未达上限不应写 exhausted");
});

test("inventiveness: 检索反思回路——连续两轮重检仍不足 → 第三次不检索、放行 closest、写 exhausted（P0-1）", async () => {
  const searches: string[] = [];
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("覆盖度")) {
        return JSON.stringify({
          adequate: false,
          covered_features: [],
          missing_features: ["识别传感器", "传送带"],
        });
      }
      return base.callLLM!(prompt);
    },
    search: async query => {
      searches.push(query);
      return [
        { title: `D: ${query.slice(0, 12)}`, snippet: "s", url: `u${searches.length}`, publication_date: "2022-01-01" },
      ];
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(searches.length, 3, "首轮 + 2 次重检 = 3 次检索，第三次不足不再检索");
  assert.ok(String(result.state.inventiveness_recall_exhausted).includes("已达上限"), "应写 exhausted 说明");
  assert.equal((result.state.prior_art as unknown[]).length, 3, "union 3 篇 ≤ 8 不收敛");
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true, "超限放行后链路仍到 conclude");
});

test("inventiveness: 检索反思回路——union 超 8 篇时收敛为最近轮优先的前 8 篇（P0-1 收敛修复）", async () => {
  const searches: string[] = [];
  const base = inventivenessProvider();
  let recallCalls = 0;
  let closestPrompt = "";
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("覆盖度")) {
        recallCalls += 1;
        if (recallCalls <= 2) {
          return JSON.stringify({
            adequate: false,
            covered_features: [],
            missing_features: ["识别传感器"],
          });
        }
        return JSON.stringify({ adequate: true, covered_features: ["传送带", "识别传感器"], missing_features: [] });
      }
      if (prompt.includes("三步法第一步")) closestPrompt = prompt;
      return base.callLLM!(prompt);
    },
    search: async query => {
      searches.push(query);
      const round = searches.length;
      // 每轮 6 篇；三轮并集 18 篇 > 8，触发 top-N 收敛
      return Array.from({ length: 6 }, (_, i) => ({
        title: `R${round}-${i + 1} 文献`,
        snippet: "摘要",
        url: `https://example.com/r${round}-${i + 1}`,
      }));
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(searches.length, 3, "首轮 + 2 次重检 = 3 次检索");
  assert.equal((result.state.prior_art as unknown[]).length, 18, "prior_art 保持全量并集（收敛写入独立键）");
  const converged = result.state._prior_art_converged as Array<Record<string, unknown>>;
  assert.equal(converged.length, 8, "收敛为最近轮优先的前 8 篇");
  assert.equal(converged[0]!.title, "R2-5 文献", "收敛起点为全量倒数第 8 篇（数组尾即最近轮）");
  assert.ok(closestPrompt.includes("R3-1 文献"), "closest 提示应含最近轮文献");
  assert.ok(!closestPrompt.includes("R1-1 文献"), "closest 提示不应含被截断的首轮文献");
});

test("inventiveness: maxRounds=0 禁用反思回路，行为与旧版等价（P0-1 回归）", async () => {
  const graph = buildInventivenessGraph({
    ruleGate: false,
    handlers: passthroughHandlers(),
    retrieval: { maxRounds: 0 },
  }).compile("parse");
  const desc = graph.describe();
  assert.ok(!desc.nodes.includes("recall_check"), "回路关闭时不应有 recall_check 节点");
  assert.ok(!desc.nodes.includes("refine_query"));
  assert.ok(!desc.nodes.includes("converge_prior_art"));
  const searches: string[] = [];
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    search: async query => {
      searches.push(query);
      return [{ title: "D1", snippet: "s", url: "u", publication_date: "2022-01-01" }];
    },
  };
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(searches.length, 1, "回路关闭时只检索一次");
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true);
});

test("inventiveness: build_query 检索式带申请日时间基准（P0-1）", async () => {
  let queryPrompt = "";
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      // 用 build_query 独有开头匹配（closest prompt 拼接的检索结果也含"检索策略"字样）。
      if (prompt.includes("基于创造性分析解析结果")) queryPrompt = prompt;
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.ok(queryPrompt.includes("时间基准"), "build_query prompt 应含时间基准要求");
  assert.ok(queryPrompt.includes("after:YYYYMMDD"), "build_query prompt 应说明 after 日期限定");
});

test("inventiveness: recall_check 降级 → 直接放行 closest，不进入重检回路（P0-1 B3）", async () => {
  const searches: string[] = [];
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("覆盖度")) throw new Error("recall LLM 不可用");
      return base.callLLM!(prompt);
    },
    search: async query => {
      searches.push(query);
      return [{ title: "D1", snippet: "s", url: "u", publication_date: "2022-01-01" }];
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(searches.length, 1, "recall 降级时不得进入重检回路");
  assert.equal(isDegraded(result.state, "inventiveness_recall"), true, "应写 recall 降级标记");
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true, "降级后链路仍到 conclude");
});

// ---------------------------------------------------------------------------
// inventiveness combination（D2 组合，P1-1）
// ---------------------------------------------------------------------------

test("inventiveness: hint 的 prompt 拼接 combination 输出的结合动机（P1-1）", async () => {
  let hintPrompt = "";
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("三步法第三步")) hintPrompt = prompt;
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.ok(hintPrompt.includes("D2 无结合启示"), "hint prompt 应含 combination 输出的 motivation");
  assert.ok(hintPrompt.includes("candidate_documents"), "hint prompt 应含 combination 输出原文");
});

test("inventiveness: 仅 1 篇 prior_art 时 combination 正常流转（combinable=false 不降级）", async () => {
  const base = inventivenessProvider();
  let combinationCalls = 0;
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("是否存在可与最接近现有技术")) {
        combinationCalls += 1;
        return JSON.stringify({
          candidate_documents: [],
          combinable: false,
          motivation: "无其他候选文件",
          obstacles: [],
          teaching_away: false,
        });
      }
      return base.callLLM!(prompt);
    },
    search: async () => {
      // 单轮单篇：仅 D1。
      return [{ title: "D1", snippet: "s", url: "u", publication_date: "2022-01-01" }];
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(combinationCalls, 1);
  assert.equal(isDegraded(result.state, "inventiveness_combination"), false, "单篇场景不降级");
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true);
});

test("inventiveness: combination LLM 缺失 → 走 degradation，图仍到规则门（P1-1）", async () => {
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("是否存在可与最接近现有技术")) throw new Error("combination LLM 不可用");
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(isDegraded(result.state, "inventiveness_combination"), true, "combination 应降级");
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true, "combination 降级后图仍到 conclude");
});

// ---------------------------------------------------------------------------
// inventiveness citation_gate（引用真实性校验，P1-2）
// ---------------------------------------------------------------------------

test("inventiveness: citation_gate 未接地引用 → failures 列出并合并进规则门（P1-2）", async () => {
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("三步法第一步")) {
        return JSON.stringify({
          document: "US9999999B2",
          technical_field: "机械分拣",
          disclosed_features: ["传送带"],
          rationale: "r",
        });
      }
      return base.callLLM!(prompt);
    },
    search: async () => [
      {
        title: "D1",
        snippet: "s",
        url: "https://patents.google.com/patent/US11452699B2",
        publication_date: "2022-01-01",
      },
    ],
  };
  const graph = buildInventivenessGraph({ handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.deepEqual(result.state.citation_gate_failures, ["US9999999B2"], "未接地引用应列出");
  assert.equal(result.state.citation_gate_grounded, false);
  assert.ok(String(result.state.citation_gate_report).includes("US9999999B2"));
  // 引用失败并入 rule_gate_failures；mock 报告原判级 blocked（缺推理要素）→ 合并规则保持 blocked。
  assert.ok((result.state.rule_gate_failures as string[]).includes("US9999999B2"));
  assert.equal(result.state.rule_gate_verdict, "blocked");
});

test("inventiveness: 引用全部接地 → citation_gate 放行，规则门判级与旧版一致（P1-2）", async () => {
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("三步法第一步")) {
        return JSON.stringify({
          document: "US11452699B2",
          technical_field: "机械分拣",
          disclosed_features: ["传送带"],
          rationale: "r",
        });
      }
      return base.callLLM!(prompt);
    },
    search: async () => [
      {
        title: "D1",
        snippet: "s",
        url: "https://patents.google.com/patent/US11452699B2",
        publication_date: "2022-01-01",
      },
    ],
  };
  const graph = buildInventivenessGraph({ handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.deepEqual(result.state.citation_gate_failures, []);
  assert.equal(result.state.citation_gate_grounded, true);
  // 接地场景下判级与无 citation_gate 干扰的基线一致（baseline: blocked，因 mock 报告缺推理要素）。
  assert.equal(result.state.rule_gate_verdict, "blocked");
  assert.ok(!(result.state.rule_gate_failures as string[]).includes("US11452699B2"));
});

test("inventiveness: 检索为空 → citation_gate 跳过硬校验（不双重惩罚，P1-2）", async () => {
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("三步法第一步")) {
        return JSON.stringify({
          document: "US9999999B2",
          technical_field: "机械分拣",
          disclosed_features: ["传送带"],
          rationale: "r",
        });
      }
      return base.callLLM!(prompt);
    },
    search: async () => [],
  };
  const graph = buildInventivenessGraph({ handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  assert.equal(result.completed, true);
  assert.deepEqual(result.state.citation_gate_failures, []);
  assert.equal(result.state.citation_gate_grounded, true);
  assert.ok(String(result.state.citation_gate_report).includes("跳过"), "检索为空时应跳过校验");
});

test("inventiveness: combination=false / citationGate=false 开关可退回旧行为（4.4）", async () => {
  const graph = buildInventivenessGraph({
    ruleGate: true,
    includeApproval: false,
    handlers: passthroughHandlers(),
    combination: false,
    citationGate: false,
  }).compile("parse");
  const desc = graph.describe();
  assert.ok(!desc.nodes.includes("combination"), "combination=false 不应有 combination 节点");
  assert.ok(!desc.nodes.includes("citation_gate"), "citationGate=false 不应有 citation_gate 节点");
  // 节点链回退：diff → hint 直连，conclude → rule_gate 直连（citationGate 关闭）。
  const result = await graph.run(
    { text: "一种分拣装置，包括传送带与识别传感器" },
    { provider: inventivenessProvider() },
  );
  assert.equal(result.completed, true);
  assert.equal(result.state.citation_gate_failures, undefined, "关闭时不应写 citation_gate 键");
  assert.ok(["pass", "blocked", "needs_revision"].includes(result.state.rule_gate_verdict as string));
});

test("inventiveness: hint 与 secondary 同超步并行（P2-1），结论与串行等价", async () => {
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const edges = graph.describe().edges;
  const comb = edges.find(([from]) => from === "combination");
  assert.ok(comb, "应有 combination 节点边");
  assert.ok(
    comb![1].includes("hint") && comb![1].includes("secondary"),
    "combination 应扇出 hint 与 secondary（同超步并行）",
  );
  // 等价性：并行结构下全流程结果与串行一致（hint/secondary 写不同 key，无合并冲突）。
  const result = await graph.run(
    { text: "一种分拣装置，包括传送带与识别传感器" },
    { provider: inventivenessProvider() },
  );
  assert.equal(result.completed, true);
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true);
  assert.equal(extracted.confidence, "medium");
  assert.ok(String(result.state.inventiveness_hint).includes("D1 无结合启示"));
  assert.ok(String(result.state.inventiveness_secondary).includes("准确率提升 30%"));
});

test("inventiveness: LLM 节点携带模型分层标识（P2-1）", async () => {
  const hints: string[] = [];
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async (prompt, opts) => {
      if (opts?.modelHint !== undefined) hints.push(opts.modelHint);
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  await graph.run({ text: "一种分拣装置，包括传送带与识别传感器" }, { provider });
  // 9 个 LLM 节点：parse/build_query/recall_check/combination 为 cheap，其余 5 个为 strong。
  assert.ok(hints.includes("cheap"), "应含 cheap 分层标识");
  assert.ok(hints.includes("strong"), "应含 strong 分层标识");
  assert.equal(hints.length, 9, "全部 9 个 LLM 节点应携带模型分层标识");
});

test("inventiveness: 化学领域用例 domain_inject 注入'预料不到的技术效果'条款（P2-2）", async () => {
  let hintPrompt = "";
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("创造性分析专家")) {
        return JSON.stringify({
          features: ["化合物", "药物组合物", "制备方法"],
          field: "医药化学",
          filing_date: "2024-01-01",
          inventor_claimed_effect: "提高生物利用度",
        });
      }
      if (prompt.includes("三步法第三步")) hintPrompt = prompt;
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种化合物及其药物组合物" }, { provider });
  assert.equal(result.completed, true);
  const focus = String(result.state.inventiveness_domain_focus ?? "");
  assert.ok(focus.includes("预料不到"), "化学领域应注入含'预料不到的技术效果'的要点");
  assert.ok(hintPrompt.includes("预料不到的技术效果"), "hint prompt 应含领域条款");
  // 注入不影响既有三步法链路。
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true);
});

test("inventiveness: 无领域命中时 domain_inject 输出空串（P2-2 不改变旧行为）", async () => {
  const base = inventivenessProvider();
  const provider: StageProvider = {
    ...base,
    callLLM: async prompt => {
      if (prompt.includes("创造性分析专家")) {
        return JSON.stringify({ features: ["通用结构件"], field: "通用", inventor_claimed_effect: "改善手感" });
      }
      return base.callLLM!(prompt);
    },
  };
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile("parse");
  const result = await graph.run({ text: "一种通用结构件" }, { provider });
  assert.equal(result.completed, true);
  assert.equal(result.state.inventiveness_domain_focus, "", "未命中领域时不注入");
  const extracted = extractInventivenessResult(result.state);
  assert.equal(extracted.inventive, true);
});
