import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import { createPatentEvalTool, evaluatePatentContent } from "../../../src/tool/builtin/patentEval.js";

const FULL_REPORT = [
  "# 技术领域",
  "本发明涉及一种自动化设备。",
  "",
  "# 背景技术",
  "现有技术中的设备存在效率低下的问题。",
  "",
  "# 发明内容",
  "# 技术方案",
  "本发明提供一种装置，包括：壳体、驱动单元和控制单元。",
  "",
  "# 有益效果",
  "本发明提高了运行效率。",
  "",
  "# 附图说明",
  "图1为整体结构示意图。",
  "",
  "# 具体实施方式",
  "实施例1：...。实施例2：...。实施例3：...。",
  "",
  "# 法律依据",
  "依据专利法第二十二条第二款。",
  "",
  "# 分析结论",
  "本申请具备新颖性。",
  "",
  "# 权利要求",
  "1. 一种装置，其特征在于，包括壳体。",
].join("\n");

test("patent_eval report mode scores a complete report above the pass line", () => {
  const result = evaluatePatentContent("report", FULL_REPORT, []);
  assert.equal(result.mode, "report");
  assert.equal(result.passed, true);
  assert.ok(result.score >= 0.7, `expected score >= 0.7, got ${result.score}`);
  assert.ok(result.details["结构完整性"], "should include 结构完整性 dimension");
  assert.match(result.details["结构完整性"].details ?? "", /已覆盖 10\/10/);
});

test("patent_eval report mode fails empty content", () => {
  const result = evaluatePatentContent("report", "", []);
  assert.equal(result.passed, false);
  assert.ok(result.score < 0.7);
});

test("patent_eval retrieval mode scores keyword coverage", () => {
  const rich = evaluatePatentContent("retrieval", "机械臂 伺服电机 减速器 视觉识别", []);
  assert.equal(rich.details["关键词覆盖"].score, 1.0);
  assert.equal(rich.passed, true);
  const sparse = evaluatePatentContent("retrieval", "机械臂", []);
  assert.equal(sparse.details["关键词覆盖"].score, 0.5);
});

test("patent_eval workflow mode detects steps", () => {
  const fiveSteps = ["步骤1 解析", "步骤2 检索", "步骤3 对比", "步骤4 生成结论", "步骤5 人工确认"].join("\n");
  const result = evaluatePatentContent("workflow", fiveSteps, []);
  assert.equal(result.details["流程完整性"].score, 1.0);
  const none = evaluatePatentContent("workflow", "没有步骤描述", []);
  assert.equal(none.details["流程完整性"].score, 0);
});

test("patent_eval citations mode checks required citations and format", () => {
  const content = "依据专利法第二十二条第二款，本申请具备新颖性；第二十二条第三款涉及创造性。";
  const result = evaluatePatentContent("citations", content, ["第二十二条第二款", "第二十二条第三款"]);
  assert.equal(result.passed, true);
  assert.equal(result.details["引用合规性"].score, 1.0);
  assert.equal(result.details["引用格式"].score, 1.0);
  const missing = evaluatePatentContent("citations", "未引用法条", ["第二十二条第二款"]);
  assert.equal(missing.details["引用合规性"].score, 0);
  assert.equal(missing.passed, false);
});

test("patent_eval comprehensive mode applies weighted composite", () => {
  const result = evaluatePatentContent("comprehensive", FULL_REPORT, ["第二十二条第二款"]);
  assert.equal(result.mode, "comprehensive");
  assert.ok(Object.keys(result.details).length >= 6, "comprehensive should merge all sub-dimensions");
  assert.equal(typeof result.score, "number");
  assert.equal(typeof result.passed, "boolean");
  assert.match(result.summary, /综合质量评分/);
});

test("patent_eval tool definition is read-only and registered under patent_eval", async () => {
  const tool = createPatentEvalTool();
  assert.equal(tool.name, "patent_eval");
  assert.equal(tool.isReadOnly({ mode: "report" }), true);
  assert.equal(tool.isConcurrencySafe({ mode: "report" }), true);
  const result = await tool.execute({ mode: "report", content: FULL_REPORT }, makeToolContext());
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  assert.ok((first.value as { passed: boolean }).passed);
});
