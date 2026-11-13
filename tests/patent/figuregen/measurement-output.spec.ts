/**
 * patent_figure_check 的**矢量量测输出**（`measurements`）：让调用方在拿到 findings
 * （哪里不对）的同时也拿到**量到的数**（图多大、线多粗、字多高）。
 *
 * 覆盖三条：
 * 1. 量测值同时出现在**结构化输出**（`data.measurements`）与**报告文本**（「矢量量测」
 *    分面）里——只在 data 里的话，模型多半读不到（它先读文本）；
 * 2. 量不到就**不编造**：不可解析的 SVG 走既有 fail-loud 语义（整次核验失败，不出半份
 *    量测），根元素未声明画布尺寸时 `width_mm`/`height_mm` **缺省**（不填 0），图中无
 *    文字时 `min_font_mm` 缺省；
 * 3. 分布顺序稳定：线宽升序、取向按线段数降序（沿用 `render-check` 的既有排序），
 *    同一份图两次核验结果完全一致。
 *
 * 输出契约（`outputSchema`）随本组用例一起校验：量测片段写错字段即变红。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import { measureSvgPaperSize } from "../../../src/patent/figuregen/svg-viewport.js";
import { validateCanonicalOutput } from "../../../src/tool/execution/outputSchemaValidation.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

/** 一条量测值（输出面 `measurements` 的一条）。 */
type Measurement = {
  path: string;
  figure_no?: number;
  width_mm?: number;
  height_mm?: number;
  text_count: number;
  min_font_mm?: number;
  stroke_width_mm: { width_mm: number; count: number }[];
  orientation_deg: { orientation_deg: number; count: number }[];
};

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-measure",
    turnId: "turn-1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      rules: { allow: [], deny: [], ask: [] },
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
    },
  };
}

const FIG: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "a", to: "b" }],
};

/** 取工具输出的 canonical data 里的量测条目（类型断言集中在这一处）。 */
function measurementsOf(result: { data?: unknown }): Measurement[] {
  const data = result.data as { measurements?: Measurement[] } | undefined;
  return data?.measurements ?? [];
}

test("patent_figure_check：矢量量测值进输出与报告（画布/文字/字高/线宽/取向）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-measure-"));
  try {
    const generate = createPatentFigureGenerateTool();
    await generate.execute({ figures: [FIG], output_name: "meas" }, makeContext(cwd));
    const svgPath = join(cwd, ".sati", "figures", "meas-fig1.svg");

    const check = createPatentFigureCheckTool();
    const result = await check.execute(
      { svg_paths: [svgPath], spec_text: "处理模块(20)对数据进行处理。" },
      makeContext(cwd),
    );

    // 输出契约自洽：量测片段进了 outputSchema，data 必须过校验（字段漂移即红）。
    assert.deepEqual(validateCanonicalOutput(result.data, check.outputSchema!), []);

    const measurements = measurementsOf(result);
    assert.equal(measurements.length, 1, "每幅被核验的 SVG 一条量测值");
    const measurement = measurements[0]!;
    assert.equal(measurement.path, svgPath);
    assert.equal(measurement.figure_no, 1, "回读到图号时给出");
    // 画布尺寸必须与根元素声明的纸面尺寸一致（同一个口径，不另算一套）。
    const paper = measureSvgPaperSize(readFileSync(svgPath, "utf8"));
    assert.ok(paper !== undefined, "产物 SVG 应声明画布尺寸");
    assert.equal(measurement.width_mm, paper.widthMm);
    assert.equal(measurement.height_mm, paper.heightMm);
    assert.ok((measurement.width_mm ?? 0) > 0, "画布宽必须是正的毫米值");
    assert.ok((measurement.height_mm ?? 0) > 0, "画布高必须是正的毫米值");
    assert.ok(measurement.text_count > 0, "文字元素数应大于 0");
    assert.ok((measurement.min_font_mm ?? 0) > 0, `最小字高应为正的毫米值：${String(measurement.min_font_mm)}`);
    assert.ok(measurement.stroke_width_mm.length > 0, "线宽分布不应为空");
    assert.ok(measurement.orientation_deg.length > 0, "取向分布不应为空");

    // 报告文本面也要能读到（不只结构化 data）：模型先读文本。
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("矢量量测"), `报告应含「矢量量测」分面：\n${text}`);
    assert.ok(text.includes(svgPath), "分面行应指出被量测的产物路径");
    assert.ok(
      text.includes(`画布 ${String(measurement.width_mm)}×${String(measurement.height_mm)} 毫米`),
      `分面行应给出画布尺寸：\n${text}`,
    );
    assert.ok(text.includes(`文字 ${String(measurement.text_count)} 个`), `分面行应给出文字数：\n${text}`);
    assert.ok(text.includes("最小字高"), `分面行应给出最小字高：\n${text}`);
    assert.ok(text.includes("线宽分布"), `分面行应给出线宽分布：\n${text}`);
    assert.ok(text.includes("取向分布"), `分面行应给出取向分布：\n${text}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：结构化 figures 通路没有 SVG ⇒ 不给量测值（不编造）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-measure-struct-"));
  try {
    const check = createPatentFigureCheckTool();
    const result = await check.execute({ figures: [FIG], spec_text: "处理模块(20)对数据进行处理。" }, makeContext(cwd));
    assert.deepEqual(measurementsOf(result), [], "结构化通路无 SVG，量测值必须为空数组");
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(!text.includes("矢量量测"), "无量测值时不得出现「矢量量测」分面");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：不可解析的 SVG 不编造量测值（整次核验失败，不出半份量测）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-measure-bad-"));
  try {
    // 外部 SVG（缺图号）：回读解析失败 ⇒ 既有 fail-loud 语义（invalid_tool_input），
    // 整次核验失败 ⇒ 既没有量测值，也没有"量到了却没报"的半份输出。
    const external = join(cwd, "external.svg");
    writeFileSync(
      external,
      `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="80mm" viewBox="0 0 100 80">` +
        `<rect x="10" y="10" width="40" height="20" fill="none" stroke="#000000"/></svg>\n`,
      "utf8",
    );
    const check = createPatentFigureCheckTool();
    await assert.rejects(
      check.execute({ svg_paths: [external], spec_text: "处理模块(20)。" }, makeContext(cwd)),
      /解析附图失败/u,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：画布未声明/无文字 ⇒ 对应量测值缺省（不填 0、不造数）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-measure-partial-"));
  try {
    // 可解析（图号在根元素属性上），但根元素未声明画布尺寸 ⇒ 画布量测缺省。
    const noCanvas = join(cwd, "no-canvas.svg");
    writeFileSync(
      noCanvas,
      `<svg xmlns="http://www.w3.org/2000/svg" data-figure-no="1">` +
        `<g id="n-a"><text x="10" y="20" font-size="10">处理模块(20)</text></g></svg>\n`,
      "utf8",
    );
    const check = createPatentFigureCheckTool();
    const result = await check.execute(
      { svg_paths: [noCanvas], spec_text: "处理模块(20)对数据进行处理。" },
      makeContext(cwd),
    );
    const measurement = measurementsOf(result)[0]!;
    assert.ok(measurement !== undefined, "可解析的 SVG 必须给出量测值");
    assert.equal(measurement.width_mm, undefined, "根元素未声明画布尺寸 ⇒ 缺省，不得填 0");
    assert.equal(measurement.height_mm, undefined, "根元素未声明画布尺寸 ⇒ 缺省，不得填 0");
    assert.equal(measurement.text_count, 1);
    assert.ok((measurement.min_font_mm ?? 0) > 0, "有文字时最小字高必须是量到的正值");

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("根元素未声明画布尺寸"), `报告须如实写明画布未声明：\n${text}`);

    // 无文字的图：文字数 0、最小字高缺省（不填 0 冒充量到的值）。
    const noText = join(cwd, "no-text.svg");
    writeFileSync(
      noText,
      `<svg xmlns="http://www.w3.org/2000/svg" data-figure-no="2" width="100mm" height="80mm" viewBox="0 0 100 80">` +
        `<g id="n-a"><rect x="10" y="10" width="40" height="20" fill="none" stroke="#000000"/></g></svg>\n`,
      "utf8",
    );
    const second = await check.execute(
      { svg_paths: [noText], spec_text: "处理模块(20)对数据进行处理。" },
      makeContext(cwd),
    );
    const secondMeasurement = measurementsOf(second)[0]!;
    assert.equal(secondMeasurement.text_count, 0);
    assert.equal(secondMeasurement.min_font_mm, undefined, "无文字时最小字高缺省，不得填 0");
    assert.equal(secondMeasurement.width_mm, 100);
    assert.equal(secondMeasurement.height_mm, 80);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：线宽升序、取向按线段数降序，且两次核验顺序一致", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-measure-order-"));
  try {
    // 1 用户单位 = 1 毫米（根元素写 mm）：线宽与取向的值可直接对账。
    const svg = join(cwd, "order-fig1.svg");
    writeFileSync(
      svg,
      `<svg xmlns="http://www.w3.org/2000/svg" data-figure-no="1" width="100mm" height="80mm" viewBox="0 0 100 80">` +
        `<line x1="10" y1="10" x2="50" y2="10" stroke="#000000" stroke-width="0.25"/>` +
        `<line x1="10" y1="20" x2="50" y2="20" stroke="#000000" stroke-width="0.35"/>` +
        `<line x1="10" y1="30" x2="50" y2="30" stroke="#000000" stroke-width="0.35"/>` +
        `<line x1="60" y1="10" x2="60" y2="40" stroke="#000000" stroke-width="0.25"/>` +
        `<g id="n-a"><text x="10" y="70" font-size="10">处理模块(20)</text></g></svg>\n`,
      "utf8",
    );
    const check = createPatentFigureCheckTool();
    const first = await check.execute(
      { svg_paths: [svg], spec_text: "处理模块(20)对数据进行处理。" },
      makeContext(cwd),
    );
    const measurement = measurementsOf(first)[0]!;

    assert.deepEqual(
      measurement.stroke_width_mm,
      [
        { width_mm: 0.25, count: 2 },
        { width_mm: 0.35, count: 2 },
      ],
      "线宽分布按线宽升序（与 render-check 的既有排序一致）",
    );
    assert.deepEqual(
      measurement.orientation_deg,
      [
        { orientation_deg: 0, count: 3 },
        { orientation_deg: 90, count: 1 },
      ],
      "取向分布按线段数降序（3 条水平线在 1 条竖直线之前）",
    );

    // 顺序稳定：同一份图两次核验的分布完全一致（排序键相同时不漂移）。
    const second = await check.execute(
      { svg_paths: [svg], spec_text: "处理模块(20)对数据进行处理。" },
      makeContext(cwd),
    );
    assert.deepEqual(measurementsOf(second), measurementsOf(first), "两次核验的量测值必须逐字段一致");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
