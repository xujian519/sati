import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import { createDraftSpecificationTool, draftSpecification } from "../../../src/tool/builtin/draftSpecification.js";

test("draft_specification assembles all five sections in order", () => {
  const result = draftSpecification({
    title: "一种自动化分拣装置",
    tech_domain: "mechanical",
    technical_problem: "现有分拣装置效率低",
    technical_solution: "包括壳体、驱动单元和分拣机构",
    beneficial_effects: "提高了分拣效率",
    drawing_descriptions: ["本发明实施例的整体结构示意图"],
    embodiments: ["实施例1：驱动单元采用伺服电机。"],
  });
  assert.deepEqual(
    result.sections.map(s => s.name),
    ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"],
  );
  // 技术领域
  assert.match(result.sections[0].content, /涉及机械技术领域/);
  // 发明内容三段式
  assert.match(result.sections[2].content, /要解决的技术问题是：现有分拣装置效率低/);
  assert.match(result.sections[2].content, /技术方案：包括壳体、驱动单元和分拣机构/);
  assert.match(result.sections[2].content, /有益效果是：提高了分拣效率/);
  assert.equal(result.sections[2].placeholder, false);
  // 附图说明
  assert.match(result.sections[3].content, /图1为/);
  // 具体实施方式
  assert.match(result.sections[4].content, /实施例1：驱动单元采用伺服电机。/);
});

test("draft_specification emits placeholders when inputs are missing", () => {
  const result = draftSpecification({ title: "一种数据处理方法", tech_domain: "software" });
  const placeholders = result.sections.filter(s => s.placeholder);
  assert.ok(placeholders.length >= 2, "missing content should yield placeholder guidance");
  assert.ok(placeholders.every(s => s.content.includes("撰写指引")));
});

test("draft_specification warns on long title and utility model without drawings", () => {
  const longTitle = draftSpecification({
    title: "一种用于自动化分拣系统的高效多级分类输送装置及其控制方法",
  });
  assert.ok(longTitle.warnings.some(w => w.includes("25 字")));
  const utility = draftSpecification({ title: "一种装置", patent_type: "utility_model" });
  assert.ok(utility.warnings.some(w => w.includes("附图")));
});

test("draft_specification preserves explicit user figure numbers", () => {
  const result = draftSpecification({
    title: "一种装置",
    tech_domain: "mechanical",
    drawing_descriptions: ["图2为爆炸图", "图5为局部放大图", "图一为整体视图", "附图2为细节图"],
  });
  assert.match(result.sections[3].content, /图2为爆炸图/);
  assert.match(result.sections[3].content, /图5为局部放大图/);
  assert.match(result.sections[3].content, /图一为整体视图/);
  assert.match(result.sections[3].content, /附图2为细节图/);
  assert.ok(!result.sections[3].content.includes("图1为爆炸图"), "should not renumber explicit figure numbers");
  assert.ok(!result.sections[3].content.includes("图1为图一为"), "should not renumber chinese-numeral figure numbers");
});

test("draft_specification auto-builds 附图说明 from figure_analysis", () => {
  const result = draftSpecification({
    title: "一种缓冲装置",
    tech_domain: "mechanical",
    technical_problem: "现有缓冲装置减震效果差",
    technical_solution: "包括壳体、缓冲层和内芯",
    beneficial_effects: "提高减震性能",
    figure_analysis: [
      {
        imagePath: "fig1.png",
        figureNumber: 1,
        figureType: "structure",
        overallDescription: "缓冲装置整体结构",
        components: [{ refNumber: "1", name: "壳体", kind: "mechanical", description: "外部壳体" }],
        connections: [],
        figureDescription: "图1是本发明实施例提供的缓冲装置的结构示意图；图中：1-壳体；",
        confidence: 0.9,
        warnings: [],
        usable: true,
        modelUsed: "moonshot/kimi-k3",
      },
    ],
  });
  // 附图说明章节自动取自 figureDescription（完整句，不套"图N为"前缀）。
  assert.match(result.sections[3].content, /图1是本发明实施例提供的缓冲装置的结构示意图/);
  assert.ok(result.sections[3].content.includes("1-壳体"), "应包含附图标记");
  assert.equal(result.sections[3].placeholder, false);
  // 人工核对提示。
  assert.ok(
    result.warnings.some(w => w.includes("自动生成")),
    "应提示附图说明由分析自动生成",
  );
});

test("draft_specification explicit drawing_descriptions take precedence over figure_analysis", () => {
  const result = draftSpecification({
    title: "一种缓冲装置",
    drawing_descriptions: ["图1为整体结构示意图"],
    figure_analysis: [
      {
        imagePath: "fig1.png",
        figureNumber: 1,
        figureType: "structure",
        overallDescription: "",
        components: [],
        connections: [],
        figureDescription: "图1是本发明实施例提供的装置的示意图；",
        confidence: 0.9,
        warnings: [],
        usable: true,
        modelUsed: "moonshot/kimi-k3",
      },
    ],
  });
  assert.match(result.sections[3].content, /图1为整体结构示意图/);
  assert.ok(!result.sections[3].content.includes("本发明实施例提供的装置"), "显式 drawing_descriptions 优先");
  assert.ok(!result.warnings.some(w => w.includes("自动生成")), "显式提供时不应提示自动生成");
});

test("draft_specification tool definition is read-only", async () => {
  const tool = createDraftSpecificationTool();
  assert.equal(tool.name, "draft_specification");
  assert.equal(tool.isReadOnly({ title: "一种装置" }), true);
  const result = await tool.execute({ title: "一种装置", technical_solution: "包括壳体" }, makeToolContext());
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  assert.ok((first.value as { sections: unknown[] }).sections.length === 5);
});
