import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Evaluator,
  createGraphRunner,
  defaultDomainGraphMap,
  evaluateSingleText,
  jaccardSimilarity,
  keywordRecall,
  llmJudge,
  parseJudgeScore,
  registerBuiltinAtoms,
  citationCompleteness,
  type EvalCase,
  type StageProvider,
} from "../../src/patent/index.js";

registerBuiltinAtoms();

/** 从测试产物向上定位仓库根目录（对齐 benchmark/loader.ts 的 repoRoot 策略）。 */
function repoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("未找到仓库根目录（向上查找 tsconfig.json 失败）");
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

test("keywordRecall: 参考答案关键词在产出中的召回", () => {
  // 长短语用核心 4 字前缀匹配（"权利要求"）。
  assert.equal(keywordRecall("权利要求应当清楚，得到说明书支持", "权利要求清楚"), 0.5);
  assert.equal(keywordRecall("本领域技术人员能够实现", "无法实现"), 0);
  assert.equal(keywordRecall("abc 123", "anything"), 1); // 无可比中文关键词 → 宽松通过
});

test("citationCompleteness: 法条引文完整率", () => {
  assert.equal(citationCompleteness("根据专利法第二十二条第三款", ["第二十二条第三款"]), 1);
  assert.equal(citationCompleteness("根据专利法第二十二条", ["第二十二条第三款"]), 0);
  assert.equal(citationCompleteness("任意文本"), 1); // 无要求引文 → 1
});

test("jaccardSimilarity: 关键词集相似度", () => {
  assert.equal(jaccardSimilarity("完全相同内容完全一致", "完全相同内容完全一致"), 1);
  assert.equal(jaccardSimilarity("完全不同领域毫不相关", "毫无关联内容不相关"), 0);
});

// ---------------------------------------------------------------------------
// llm-judge
// ---------------------------------------------------------------------------

test("parseJudgeScore: 解析 JSON/纯数字输出", () => {
  assert.equal(parseJudgeScore('{"score": 0.8, "rationale": "ok"}'), 0.8);
  assert.equal(parseJudgeScore("0.65"), 0.65);
  assert.equal(parseJudgeScore("无法评分"), undefined);
  assert.equal(parseJudgeScore('{"score": 1.5}'), 1); // clamp
});

test("llmJudge: N 采样取中位数", async () => {
  const judge = {
    callLLM: async () => JSON.stringify({ score: 0.7, rationale: "x" }),
  };
  const score = await llmJudge(judge, "题目", "答案", "参考答案", { samples: 3 });
  assert.equal(score, 0.7);
});

test("llmJudge: 全部采样失败返回 undefined", async () => {
  const judge = {
    callLLM: async () => "不是分数",
  };
  const score = await llmJudge(judge, "题目", "答案", undefined, { samples: 2 });
  assert.equal(score, undefined);
});

// ---------------------------------------------------------------------------
// runner + evaluator
// ---------------------------------------------------------------------------

test("evaluateSingleText: 单文本规则门评估（缺要素 → blocked）", () => {
  // patent_novelty 域含单独对比/特征覆盖/优先权/公开方式规则：缺论证 → blocked。
  const incomplete = evaluateSingleText("结论：具备新颖性", ["patent_novelty"]);
  assert.equal(incomplete.verdict, "blocked");
  assert.ok(incomplete.failures.includes("NOVELTY-SINGLE-COMPARISON"));
  const empty = evaluateSingleText("", ["patent_inventiveness"]);
  assert.equal(empty.verdict, "blocked");
});

test("defaultDomainGraphMap: 按 caseId/businessTask/expected 映射子图", () => {
  assert.equal(
    defaultDomainGraphMap({ id: "patent_exam_2009_novelty_01", domain: "patent", input: "", expected: "" }),
    "novelty",
  );
  assert.equal(
    defaultDomainGraphMap({ id: "patent_exam_2008_a26_3_01", domain: "patent", input: "", expected: "" }),
    "enablement",
  );
  assert.equal(
    defaultDomainGraphMap({ id: "patent_exam_2009_a22_01", domain: "patent", input: "", expected: "" }),
    "inventiveness",
  );
  assert.equal(
    defaultDomainGraphMap({ id: "patent_exam_2008_a31_01", domain: "patent", input: "", expected: "" }),
    undefined,
  );
  // A22.2 新颖性精确判别（真题 id 带 .2）优先于宽松 a22 前缀。
  assert.equal(
    defaultDomainGraphMap({ id: "patent_exam_2010_a22_2_01", domain: "patent", input: "", expected: "" }),
    "novelty",
  );
  assert.equal(
    defaultDomainGraphMap({ id: "patent_exam_2010_a22_3_01", domain: "patent", input: "", expected: "" }),
    "inventiveness",
  );
  // expected 语义兜底：id 只有 "a22" 时按答案要旨判别（2010 真题为新颖性 + 数值范围）。
  assert.equal(
    defaultDomainGraphMap({
      id: "patent_exam_2010_a22_02",
      domain: "patent",
      input: "",
      expected: "大范围被对比文件中 0.15%C 公开，不具备新颖性",
    }),
    "novelty",
  );
  // 无"新颖/创造"语义（如无效实务题修改策略）回落宽松 a22 → inventiveness。
  assert.equal(
    defaultDomainGraphMap({
      id: "patent_exam_2007_a22_01",
      domain: "patent",
      input: "",
      expected: "修改方式：删除原独立权利要求，将从属权利要求合并为新独立权利要求",
    }),
    "inventiveness",
  );
});

test("a22.3 fixture：创造性专属基准可加载、全部映射到 inventiveness 图、方向标记合法", () => {
  const path = join(repoRoot(import.meta.url), "tests/patent/benchmark/fixtures/patent-exam-real-a22.3.json");
  const fixture = JSON.parse(readFileSync(path, "utf8")) as { suite: string; caseCount: number; cases: EvalCase[] };
  assert.equal(fixture.suite, "patent-exam-real-a22.3");
  assert.equal(fixture.cases.length, fixture.caseCount);
  assert.ok(fixture.cases.length >= 8 && fixture.cases.length <= 10, "首批 8-10 条");
  let inventive = 0;
  let notInventive = 0;
  for (const c of fixture.cases) {
    assert.equal(defaultDomainGraphMap(c), "inventiveness", `${c.id} 应映射到 inventiveness 图`);
    assert.ok(Array.isArray(c.requiredCitations) && c.requiredCitations.length > 0, `${c.id} 缺 requiredCitations`);
    const marks = c.expected.split("\n").filter(line => /^结论：(具备|不具备)创造性\s*$/.test(line));
    assert.equal(marks.length, 1, `${c.id} expected 应恰好含一个单行结论方向标记`);
    if (marks[0]!.includes("不具备创造性")) notInventive += 1;
    else inventive += 1;
  }
  assert.ok(inventive >= 3, `具备创造性方向至少 3 条（实际 ${inventive}）`);
  assert.ok(notInventive >= 3, `不具备创造性方向至少 3 条（实际 ${notInventive}）`);
});

test("createGraphRunner + Evaluator: 图模式跑 fixture 并产出指标", async () => {
  const provider: StageProvider = {
    callLLM: async prompt => {
      if (prompt.includes("完整新颖性分析报告")) {
        return "新颖性分析报告：权利要求相对于现有技术 D1 具备新颖性（单独对比原则，逐技术特征比对）。";
      }
      if (prompt.includes("数值范围")) {
        return JSON.stringify({
          assessments: [{ range: "50-80", category: "重叠区间", disclosed: false, reasoning: "x" }],
        });
      }
      if (prompt.includes("技术分析助手")) {
        return JSON.stringify({ features: ["传送带"], problems: [], effects: [] });
      }
      if (prompt.includes("检索关键词")) {
        return JSON.stringify({ keywords: ["分拣"] });
      }
      if (prompt.includes("新颖性分析专家")) {
        return JSON.stringify({
          assessments: [{ feature: "传送带", prior_art: "D1", disclosed: false, reasoning: "未公开" }],
          conclusion: "具备新颖性",
        });
      }
      return "默认";
    },
    search: async query => [{ title: `文献: ${query}`, snippet: "摘要", url: "u" }],
  };
  const runner = createGraphRunner({ provider });
  const evaluator = new Evaluator(runner, { passLine: 0.5 });
  const cases: EvalCase[] = [
    {
      id: "patent_exam_2009_novelty_01",
      domain: "patent",
      input: "一种分拣装置，温度范围为 50-80°C，包含传送带",
      expected: "新颖性 单独对比 技术特征",
    },
    { id: "patent_exam_2008_a31_01", domain: "patent", input: "单一性问题", expected: "单一性" },
  ];
  const report = await evaluator.evaluateCases(cases);
  assert.equal(report.total, 2);
  assert.equal(report.degradedCount, 0);
  // 图模式用例：规则门/关键词指标已计算。
  const graphCase = report.cases.find(c => c.caseId === "patent_exam_2009_novelty_01");
  assert.ok(graphCase);
  assert.ok("keyword_recall" in graphCase.metrics);
  assert.ok("rule_gate_pass" in graphCase.metrics);
  // fallback 用例（a31 未建图）：单文本规则门，产出 = 输入。
  const fallbackCase = report.cases.find(c => c.caseId === "patent_exam_2008_a31_01");
  assert.ok(fallbackCase);
  assert.equal(fallbackCase.output, "单一性问题");
});
