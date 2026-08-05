import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSlop,
  detectStructureIssues,
  formatSlopAnalysis,
  runChecklist,
  scoreDocument,
} from "../../src/patent/index.js";

// ---------------------------------------------------------------------------
// 短语层：删除/替换
// ---------------------------------------------------------------------------

test("短语层：填充词与空泛修饰被删除", () => {
  const analysis = analyzeSlop("综上所述，进一步地，本方案具有显著进步。");
  assert.ok(analysis.changes.length >= 3, `期望 ≥3 处改动，实际 ${analysis.changes.length}`);
  assert.ok(!analysis.cleaned.includes("综上所述"));
  assert.ok(!analysis.cleaned.includes("进一步地"));
  assert.ok(!analysis.cleaned.includes("显著进步"));
});

test("短语层：无主句（得以）被删除", () => {
  const analysis = analyzeSlop("创造性障碍得以克服，审查意见所指缺陷得以消除。");
  assert.ok(analysis.changes.some(c => c.original.includes("得以克服")));
  assert.ok(analysis.changes.some(c => c.original.includes("得以消除")));
});

test("短语层：免责堆叠折叠为单一免责声明", () => {
  const analysis = analyzeSlop("以上分析仅供参考，不构成法律意见");
  assert.equal(analysis.cleaned.includes("仅供参考。"), true);
  assert.equal(analysis.cleaned.includes("不构成法律意见"), false);
});

test("短语层：不做全局空白清理（markdown 安全：缩进代码块/围栏空行不被破坏）", () => {
  // 缩进引用与两空格硬换行是专利文本常见形态，全局空白规则会破坏 markdown 语义
  const analysis = analyzeSlop("    claim 1: A+B\n\n\nline2");
  assert.ok(analysis.cleaned.includes("    claim 1: A+B"), "行首缩进应保留");
  assert.ok(analysis.cleaned.includes("\n\n\n"), "围栏代码块内空行应保留");
});

// ---------------------------------------------------------------------------
// 结构层：六种缺陷
// ---------------------------------------------------------------------------

test("结构层：假三步法（区别特征无段落号）", () => {
  const issues = detectStructureIssues("区别特征是权利要求1的技术特征。");
  assert.ok(
    issues.some(i => i.type === "empty_three_step"),
    "应检出假三步法",
  );
});

test("结构层：假三步法豁免（含段落号映射不误报）", () => {
  // 有段落号且无"冒号后无证据"形态（逗号连接，冒号后直接跟 D1 编号）→ 不误报
  const issues = detectStructureIssues("区别特征是权利要求1的技术特征，参见对比文件D1¶0123，弹簧为压缩弹簧。");
  assert.ok(!issues.some(i => i.type === "empty_three_step"), "有段落号不应误报");
  // "区别特征：……"冒号后无 D 编号 → 仍报
  const bare = detectStructureIssues("区别特征：为压缩弹簧。");
  assert.ok(
    bare.some(i => i.type === "empty_three_step"),
    "冒号后无证据应报",
  );
});

test("结构层：假对比表（表格无段落号/年份）", () => {
  const issues = detectStructureIssues("| 特征 | 本申请 | D1 |\n| 弹簧 | 压缩 | 拉伸 |");
  assert.ok(issues.some(i => i.type === "fake_comparison"));
});

test("结构层：假转折（不是X而是Y）", () => {
  const issues = detectStructureIssues("这不是技术问题，而是审查标准问题。");
  assert.ok(issues.some(i => i.type === "binary_turn"));
});

test("结构层：被动语态隐藏主体", () => {
  const issues = detectStructureIssues("本申请被认定为缺乏创造性。");
  assert.ok(issues.some(i => i.type === "passive_voice"));
  // 明确主体不误报
  const ok = detectStructureIssues("审查员驳回了本申请。");
  assert.ok(!ok.some(i => i.type === "passive_voice"));
});

test("结构层：OA 公式化表述", () => {
  const issues = detectStructureIssues("审查员认定有误，请审查员重新考虑。");
  assert.ok(issues.some(i => i.type === "oa_formula"));
});

test("结构层：理由堆砌（≥4 条理由）", () => {
  const issues = detectStructureIssues(
    "理由一：专利法第22条；理由二：专利法第22条第3款；理由三：专利法第26条第4款；理由四：专利法第33条。",
  );
  assert.ok(issues.some(i => i.type === "reason_pile"));
});

// ---------------------------------------------------------------------------
// 评分层：43 分五维（directness 8 / evidence 10 / rhythm 8 / practicality 9 / concision 8，满分 43，通过线 35）
// ---------------------------------------------------------------------------

test("评分：实质内容文档高分通过（≥35）", () => {
  const text = [
    "## 争点：权利要求1是否具备创造性",
    "",
    "审查员认为权利要求1相对于D1不具备创造性，本申请认为该认定有误。",
    "区别特征是压缩弹簧（D1¶0123 公开的为拉伸弹簧，权1），属于结构差异。",
    "该区别特征带来技术效果：减小体积（D1 无此教导）。",
    "综上，权利要求1具备创造性。",
  ].join("\n");
  const analysis = analyzeSlop(text);
  assert.ok(analysis.score.total >= 35, `总分 ${analysis.score.total} 应 ≥35`);
  assert.equal(analysis.score.passed, true);
});

test("评分：套话堆砌文档低分不通过（<35）", () => {
  const text = [
    "综上所述，进一步地，值得一提的是，本方案具有显著进步。",
    "质的飞跃，革命性，颠覆性。",
    "不难发现，显而易见地，本领域技术人员能够理解。",
    "创造性障碍得以克服。",
    "保护范围合理。",
  ].join("\n");
  const analysis = analyzeSlop(text);
  assert.ok(analysis.score.total < 35, `总分 ${analysis.score.total} 应 <35`);
  assert.equal(analysis.score.passed, false);
});

test("评分：scoreDocument 直接调用", () => {
  const score = scoreDocument("争点明确。D1¶0123 公开了压缩弹簧。", [], []);
  assert.ok(score.total >= 35);
});

// ---------------------------------------------------------------------------
// 快检清单
// ---------------------------------------------------------------------------

test("快检：孤立特征论述未通过", () => {
  const checklist = runChecklist("该方案的特征在于……", []);
  const item = checklist.find(i => i.question.includes("特征论述"));
  assert.ok(item, "应有特征论述检查项");
  assert.equal(item!.passed, false);
});

test("快检：夸张修饰无数据未通过", () => {
  const checklist = runChecklist("本方案效果显著、具有质的飞跃。", []);
  const item = checklist.find(i => i.question.includes("实验数据"));
  assert.ok(item, "应有夸张修饰检查项");
  assert.equal(item!.passed, false);
});

// ---------------------------------------------------------------------------
// 报告渲染
// ---------------------------------------------------------------------------

test("报告：格式完整且含评分", () => {
  const analysis = analyzeSlop("综上所述，区别特征无段落号。");
  const report = formatSlopAnalysis(analysis);
  assert.match(report, /反套话润色报告/);
  assert.match(report, /评分：\d+\/43/, "43 分制渲染（五维上限 8/10/8/9/8，满分 43）");
  assert.match(report, /短语删除\/替换|结构缺陷/);
});

// ---------------------------------------------------------------------------
// patent_eval 集成
// ---------------------------------------------------------------------------

test("patent_eval：表达质量维度基于反套话引擎", async () => {
  const { createPatentEvalTool } = await import("../../src/tool/builtin/patentEval.js");
  const tool = createPatentEvalTool();
  const bad = await tool.execute(
    {
      mode: "report",
      content: "综上所述，进一步地，本方案具有显著进步。质的飞跃，创造性障碍得以克服。",
    },
    {} as never,
  );
  const details = bad.data!.details as Record<string, { score: number; passed: boolean; details?: string }>;
  assert.ok(details["表达质量"], "应有表达质量维度");
  assert.ok(details["表达质量"]!.details!.includes("短语套话"), `细节应含短语统计: ${details["表达质量"]!.details}`);

  const good = await tool.execute(
    {
      mode: "report",
      content: "## 争点\n\n权利要求1的创造性。区别特征见 D1¶0123。本申请具备创造性。",
    },
    {} as never,
  );
  const goodDetails = good.data!.details as Record<string, { score: number; passed: boolean; details?: string }>;
  assert.ok(goodDetails["表达质量"]!.passed, "实质内容文档表达质量应通过");
});

test("patent_eval：绝对化表述恢复参与表达质量评分（P-A07）", async () => {
  const { createPatentEvalTool } = await import("../../src/tool/builtin/patentEval.js");
  const tool = createPatentEvalTool();
  const absolute = await tool.execute(
    {
      mode: "report",
      content: "## 争点\n\n毫无疑问，本申请具有创造性，绝对优于对比文件，必然获得授权。",
    },
    {} as never,
  );
  const details = absolute.data!.details as Record<string, { score: number; passed: boolean; details?: string }>;
  assert.ok(
    details["表达质量"]!.details!.includes("绝对化表述"),
    `细节应含绝对化统计: ${details["表达质量"]!.details}`,
  );
  // 同长度干净文本的评分应高于绝对化文本
  const clean = await tool.execute(
    {
      mode: "report",
      content: "## 争点\n\n本申请具有创造性，优于对比文件，具备授权前景。",
    },
    {} as never,
  );
  const cleanDetails = clean.data!.details as Record<string, { score: number; passed: boolean; details?: string }>;
  assert.ok(
    cleanDetails["表达质量"]!.score! > details["表达质量"]!.score!,
    `绝对化应降低评分: ${cleanDetails["表达质量"]!.score} vs ${details["表达质量"]!.score}`,
  );
});
