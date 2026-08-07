import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import {
  checkEffectQuantification,
  checkFigureMarkConsistency,
  checkNumericRangeCoverage,
  checkSmilesValidity,
  computeSpecScore,
  createValidateSpecificationTool,
  extractClaimFeatures,
  extractNumericValues,
  validateSpecification,
  type SpecViolation,
} from "../../../src/tool/builtin/validateSpecification.js";
import type { FigureAnalysisResult } from "../../../src/patent/figure/types.js";

const GOOD_SPEC = [
  "# 技术领域",
  "本发明涉及机械技术领域。",
  "",
  "# 背景技术",
  "现有技术存在效率低下的问题。",
  "",
  "# 发明内容",
  "本发明提供一种装置，包括壳体、驱动单元。",
  "",
  "# 附图说明",
  "图1为本发明实施例的整体结构示意图。",
  "",
  "# 具体实施方式",
  "实施例1：如图1所示，驱动单元采用伺服电机。",
].join("\n");

const GOOD_ABSTRACT = "本发明公开了一种自动化分拣装置。摘要附图为图1。关键词：自动化分拣；驱动单元。";

test("validate_specification passes a complete specification", () => {
  const result = validateSpecification({
    text: GOOD_SPEC,
    title: "一种自动化分拣装置",
    abstract: GOOD_ABSTRACT,
  });
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.equal(result.violations.length, 0);
});

test("validate_specification flags missing sections and long title", () => {
  const result = validateSpecification({
    text: "# 技术领域\n本发明涉及机械技术领域。",
    title: "一种用于自动化分拣系统的高效多级分类输送装置及其控制方法",
  });
  assert.equal(result.passed, false);
  const sectionViolation = result.violations.find(v => v.rule === "sections");
  assert.ok(sectionViolation, "should flag missing sections");
  assert.match(sectionViolation?.message ?? "", /缺少必要章节：背景技术、发明内容、附图说明、具体实施方式/);
  const titleViolation = result.violations.find(v => v.rule === "title_length");
  assert.ok(titleViolation, "should flag title length");
});

test("validate_specification flags vague terms and drawing inconsistencies", () => {
  const result = validateSpecification({
    text: GOOD_SPEC.replace("驱动单元采用伺服电机", "驱动单元优选采用伺服电机"),
  });
  const clarity = result.violations.find(v => v.rule === "clarity");
  assert.ok(clarity, "should flag vague terms");
  assert.ok(clarity?.message.includes("优选"));

  // 正文无图引用但有附图说明章节
  const noBodyRef = validateSpecification({
    text: GOOD_SPEC.replace("实施例1：如图1所示，驱动单元采用伺服电机。", "实施例1：驱动单元采用伺服电机。"),
  });
  assert.ok(
    noBodyRef.violations.some(v => v.rule === "drawings"),
    "should warn when body never references figures",
  );
});

test("validate_specification flags abstract over 300 chars", () => {
  const result = validateSpecification({
    text: GOOD_SPEC,
    abstract: "长摘要".repeat(110),
  });
  assert.ok(result.violations.some(v => v.rule === "abstract_length"));
});

test("validate_specification flags missing abstract keywords and abstract drawing", () => {
  const result = validateSpecification({
    text: GOOD_SPEC,
    abstract: "本发明公开了一种自动化分拣装置。",
  });
  assert.ok(
    result.violations.some(v => v.rule === "abstract_keywords"),
    "should flag missing keywords",
  );
  assert.ok(
    result.violations.some(v => v.rule === "abstract_drawing"),
    "should flag missing abstract drawing",
  );
});

test("validate_specification flags missing embodiments", () => {
  const result = validateSpecification({
    text: "# 具体实施方式\n本领域技术人员可知如何实施该装置。",
  });
  assert.ok(result.violations.some(v => v.rule === "embodiments"));
});

test("claim coverage: fully missing features → error, partial → warning", () => {
  const claims =
    "1. 一种自动化分拣装置，其特征在于，包括：所述加热组件，用于加热物料；" +
    "所述传动机构，用于传递动力；所述分拣臂，用于抓取物品。";
  const fullMissing = validateSpecification({ text: GOOD_SPEC, claims });
  const cov = fullMissing.violations.find(v => v.rule === "claim_coverage");
  assert.ok(cov, "should flag missing feature coverage");
  assert.equal(cov?.severity, "error");
  assert.match(cov?.message ?? "", /加热组件/);

  // 驱动单元与壳体已在说明书记载 → 部分缺失（1/3）→ warning
  const partial = validateSpecification({
    text: GOOD_SPEC,
    claims:
      "1. 一种自动化分拣装置，其特征在于，包括：所述驱动单元，用于提供动力；" +
      "所述壳体，用于容纳部件；所述分拣臂，用于抓取物品。",
  });
  const partialCov = partial.violations.find(v => v.rule === "claim_coverage");
  assert.equal(partialCov?.severity, "warning");
});

test("claim coverage: extractClaimFeatures extracts refs and numeric values", () => {
  const features = extractClaimFeatures("1. 一种装置，其特征在于，包括：所述加热组件；所述传动机构；温度为60℃。");
  assert.ok(features.includes("加热组件"));
  assert.ok(features.includes("传动机构"));
  assert.ok(features.includes("60°"), "温度单位应归一化为 60°");
  assert.ok(!features.includes("装置"), "通用词应被过滤");
});

test("numeric range: missing endpoints → error, missing midpoint → warning, complete → pass", () => {
  const base = "# 具体实施方式\n实施例1：加热温度为20-90℃。";
  const noEndpoint = validateSpecification({ text: base });
  assert.ok(
    noEndpoint.violations.some(v => v.rule === "numeric_range_endpoints"),
    "端点无实施例应报 error",
  );

  const withEndpoints = validateSpecification({
    text: base + "\n实施例2：加热温度为20℃。\n实施例3：加热温度为90℃。",
  });
  const noMid = withEndpoints.violations.find(v => v.rule === "numeric_range_midpoint");
  assert.ok(noMid, "有端点无中间值应报 warning");

  const complete = validateSpecification({
    text: base + "\n实施例2：加热温度为20℃。\n实施例3：加热温度为90℃。\n实施例4：加热温度为60℃。",
  });
  assert.ok(!complete.violations.some(v => v.rule.startsWith("numeric_range")));
});

test("numeric range: helper detects endpoint and midpoint coverage", () => {
  // 只有中间值 60℃：端点全缺 → endpointMissing 报 1 条，中间值已命中
  const onlyMid = checkNumericRangeCoverage("实施例1：温度为20-90℃。实施例2：温度为60℃。");
  assert.equal(onlyMid.endpointMissing.length, 1, "缺 20℃/90℃ 端点");
  assert.equal(onlyMid.endpointMissing[0]?.min, 20);
  assert.equal(onlyMid.midpointMissing.length, 0);

  // 补 90℃ 端点（一端命中即视为有端点实施例，两端值最好但非绝对要求）
  const withMax = checkNumericRangeCoverage("实施例1：温度为20-90℃。实施例2：温度为60℃。实施例3：温度为90℃。");
  assert.equal(withMax.endpointMissing.length, 0);
});

test("numeric range: 多字符单位优先解析（mg/MPa/min/mm），不误截断", () => {
  const values = extractNumericValues("用量5mg，压力2MPa，时间30min，长度5mm。");
  assert.deepEqual(new Set(values.map(v => v.unit)), new Set(["mg", "MPa", "min", "mm"]));

  // 0.1-2MPa 范围：端点与中间值均有实施例 → 不误报 numeric_range
  const result = validateSpecification({
    text:
      "# 具体实施方式\n实施例1：压力为0.1-2MPa。\n实施例2：压力为0.1MPa。\n" +
      "实施例3：压力为1MPa。\n实施例4：压力为2MPa。",
  });
  assert.ok(!result.violations.some(v => v.rule.startsWith("numeric_range")));
});

test("effect quantification: vague effect without data → warning, quantified → pass", () => {
  const vague = validateSpecification({
    text: "# 发明内容\n本发明的有益效果是：效果好，效率显著提升。",
  });
  assert.ok(vague.violations.some(v => v.rule === "effect_data_quantified"));
  assert.ok(checkEffectQuantification("效果好。")[0]?.includes("效果好"));

  const quantified = validateSpecification({
    text: "# 发明内容\n本发明的有益效果是：效率提升30%。",
  });
  assert.ok(!quantified.violations.some(v => v.rule === "effect_data_quantified"));
});

test("chemical: chemical domain without characterization → warning, with data → pass", () => {
  const missing = validateSpecification({
    text: "# 具体实施方式\n实施例1：制备化合物A。",
    tech_domain: "chemical",
  });
  assert.ok(missing.violations.some(v => v.rule === "chemical_characterization"));

  const withData = validateSpecification({
    text: "# 具体实施方式\n实施例1：制备化合物A，其NMR谱图显示目标结构。",
    tech_domain: "chemical",
  });
  assert.ok(!withData.violations.some(v => v.rule === "chemical_characterization"));

  // 非化学领域不触发
  const mechanical = validateSpecification({
    text: "# 具体实施方式\n实施例1：制备装置A。",
    tech_domain: "mechanical",
  });
  assert.ok(!mechanical.violations.some(v => v.rule === "chemical_characterization"));
});

test("validate_specification tool definition is read-only", async () => {
  const tool = createValidateSpecificationTool();
  assert.equal(tool.name, "validate_specification");
  assert.equal(tool.isReadOnly({ text: "" }), true);
  const result = await tool.execute({ text: GOOD_SPEC }, makeToolContext());
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  assert.equal((first.value as { passed: boolean }).passed, true);
});

// ---------------------------------------------------------------------------
// 图文一致性校验（figure_analysis 联动）
// ---------------------------------------------------------------------------

function makeFigureAnalysis(overrides: Partial<FigureAnalysisResult> = {}): FigureAnalysisResult {
  return {
    imagePath: "fig1.png",
    figureNumber: 1,
    figureType: "structure",
    overallDescription: "缓冲装置整体结构",
    components: [
      { refNumber: "1", name: "壳体", kind: "mechanical", description: "外部壳体" },
      { refNumber: "2", name: "缓冲层", kind: "mechanical", description: "缓冲结构" },
    ],
    connections: [],
    figureDescription: "图1是本发明实施例提供的缓冲装置的结构示意图；图中：1-壳体；2-缓冲层；",
    confidence: 0.9,
    warnings: [],
    usable: true,
    modelUsed: "moonshot/kimi-k3",
    ...overrides,
  };
}

const SPEC_WITH_DRAWINGS = [
  "# 技术领域",
  "本发明涉及机械技术领域。",
  "# 背景技术",
  "现有技术缓冲效果差。",
  "# 发明内容",
  "本发明提供一种缓冲装置，包括壳体、缓冲层。",
  "# 附图说明",
  "图1是本发明实施例提供的缓冲装置的结构示意图；图中：1-壳体；2-缓冲层；",
  "# 具体实施方式",
  "实施例1：如图1所示，壳体1内设置缓冲层2。",
].join("\n");

test("checkFigureMarkConsistency: 标号一致时无违规", () => {
  const violations = checkFigureMarkConsistency(SPEC_WITH_DRAWINGS, [makeFigureAnalysis()]);
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

test("checkFigureMarkConsistency: 附图说明漏标时警告", () => {
  const spec = SPEC_WITH_DRAWINGS.replace("图中：1-壳体；2-缓冲层；", "图中：1-壳体；");
  const violations = checkFigureMarkConsistency(spec, [makeFigureAnalysis()]);
  assert.ok(
    violations.some(v => v.rule === "figure_mark_consistency" && v.severity === "warning" && v.message.includes("2")),
    "应警告附图标记 2 未在附图说明中列出",
  );
});

test("checkFigureMarkConsistency: 附图说明悬空标号时报错", () => {
  const spec = SPEC_WITH_DRAWINGS.replace("图中：1-壳体；2-缓冲层；", "图中：1-壳体；2-缓冲层；9-未知部件；");
  const violations = checkFigureMarkConsistency(spec, [makeFigureAnalysis()]);
  assert.ok(
    violations.some(v => v.rule === "figure_mark_consistency" && v.severity === "error" && v.message.includes("9")),
    "应报错附图说明中的标记 9 在附图中不存在",
  );
});

test("checkFigureMarkConsistency: 分析不可用时仅提示人工核对", () => {
  const violations = checkFigureMarkConsistency(SPEC_WITH_DRAWINGS, [makeFigureAnalysis({ usable: false })]);
  assert.equal(violations.length, 1);
  assert.ok(violations[0]?.message.includes("人工核对"), "应提示人工核对而非强校验");
});

test("validate_specification: figure_analysis 联动图文一致性", () => {
  const specWithDangling = SPEC_WITH_DRAWINGS.replace("图中：1-壳体；2-缓冲层；", "图中：1-壳体；2-缓冲层；8-支架；");
  const result = validateSpecification({ text: specWithDangling, figure_analysis: [makeFigureAnalysis()] });
  assert.ok(
    result.violations.some(v => v.rule === "figure_mark_consistency" && v.severity === "error"),
    "应报错悬空标号",
  );
});

test("checkFigureMarkConsistency: 部分图不可用时仅提示人工核对、可用图照常校验（标号齐全不报漏标）", () => {
  const usableFig = makeFigureAnalysis();
  const unusableFig = makeFigureAnalysis({ usable: false, figureNumber: 2 });
  const violations = checkFigureMarkConsistency(SPEC_WITH_DRAWINGS, [usableFig, unusableFig]);
  assert.ok(
    violations.some(v => v.message.includes("不可用")),
    "应提示存在不可用图",
  );
  assert.ok(
    !violations.some(v => v.rule === "figure_mark_consistency" && v.message.includes("未在附图说明中列出")),
    "可用图标号齐全时不应报漏标",
  );
});

test("checkFigureMarkConsistency: 部分图不可用时仍校验可用图的漏标", () => {
  const usableFig = makeFigureAnalysis();
  const unusableFig = makeFigureAnalysis({ usable: false, figureNumber: 2 });
  const spec = SPEC_WITH_DRAWINGS.replace("图中：1-壳体；2-缓冲层；", "图中：1-壳体；");
  const violations = checkFigureMarkConsistency(spec, [usableFig, unusableFig]);
  assert.ok(
    violations.some(v => v.message.includes("不可用")),
    "应提示存在不可用图",
  );
  assert.ok(
    violations.some(v => v.severity === "warning" && v.message.includes("2")),
    "可用图存在漏标时仍应报出（不 all-or-nothing）",
  );
});

test("computeSpecScore: error 扣 0.25 / warning 扣 0.1，clamp 到 0，passed 仅受 error 影响", () => {
  const error: SpecViolation = { rule: "r", severity: "error", message: "e" };
  const warning: SpecViolation = { rule: "r", severity: "warning", message: "w" };

  assert.deepEqual(computeSpecScore([]), { passed: true, score: 1 });
  assert.deepEqual(computeSpecScore([warning]), { passed: true, score: 0.9 });
  assert.deepEqual(computeSpecScore([error]), { passed: false, score: 0.75 });
  assert.deepEqual(computeSpecScore([error, warning, warning]), { passed: false, score: 0.55 });
  // 扣分下限 clamp：6 条 error = -1.5 → 0
  assert.deepEqual(computeSpecScore(Array.from({ length: 6 }, () => error)), { passed: false, score: 0 });
});

test("checkSmilesValidity: 无候选/合法 SMILES 静默跳过", async () => {
  assert.deepEqual(await checkSmilesValidity("纯中文文本，不含任何化学实体。"), []);
  assert.deepEqual(await checkSmilesValidity("化合物为阿司匹林 CC(=O)Oc1ccccc1C(=O)O。"), []);
});

test("checkSmilesValidity: 非法 SMILES 追加 warning 级违规（不影响 passed 语义）", async () => {
  // 超价碳：RDKit sanitization 失败（或抛 WASM 异常，经 H2 修复后归一为 ok=false）
  const violations = await checkSmilesValidity("该化合物结构为 C(=O)(=O)(=O)C。");
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, "smiles_validity");
  assert.equal(violations[0]?.severity, "warning");
  assert.match(violations[0]?.message ?? "", /未通过 RDKit 校验/);
});
