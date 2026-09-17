/**
 * patent_figure_generate / patent_figure_check 工具层测试。
 *
 * 直接调用 execute（不经 registry）：落盘路径、附图说明草稿、核验文本、
 * 非法输入 fail-closed。工具为 opt-in 注册（不进默认注册表，见
 * createBuiltinRegistry patentFigure 注释）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import { parseFigureSidecar } from "../../../src/patent/figuregen/sidecar.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-test",
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

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "sati-figuregen-"));
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

test("patent_figure_generate：SVG 落盘 + 附图说明草稿", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    const result = await tool.execute(
      {
        figures: [FIG],
        output_name: "case-a",
        document_kind: "invention",
        invention_name: "一种处理装置",
      },
      makeContext(cwd),
    );
    const svgPath = join(cwd, ".sati", "figures", "case-a-fig1.svg");
    assert.ok(existsSync(svgPath), `应落盘 ${svgPath}`);
    assert.ok(readFileSync(svgPath, "utf8").includes('data-ref="20"'));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("图1: "));
    assert.ok(text.includes("图1为本发明实施例提供的一种处理装置的方法流程示意图"));
    const fileBlocks = result.content.filter(block => block.type === "file");
    // SVG + 附图 sidecar
    assert.equal(fileBlocks.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_generate：落盘 sidecar，spec 无损且可重放全部规则", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute({ figures: [FIG], output_name: "case-s", document_kind: "utility" }, makeContext(cwd));

    const sidecarPath = join(cwd, ".sati", "figures", "case-s-figures.json");
    assert.ok(existsSync(sidecarPath), "应落盘 sidecar");
    const sidecar = parseFigureSidecar(readFileSync(sidecarPath, "utf8"));
    assert.equal(sidecar.version, 1);
    assert.equal(sidecar.output_name, "case-s");
    assert.equal(sidecar.renderer, "builtin");
    assert.equal(sidecar.jurisdiction, "cn");
    assert.equal(sidecar.document_kind, "utility");
    assert.ok(sidecar.generated_at.length > 0, "应记落盘时刻（审计用）");
    assert.equal(sidecar.check.stage, "generation");
    assert.equal(sidecar.check.skip_text_rules, true);

    // 无损：sidecar 里的 spec 与入参逐字段一致
    assert.deepEqual(
      sidecar.figures.map(f => f.figure_no),
      [1],
    );
    assert.deepEqual(sidecar.figures[0].spec, FIG);
    assert.equal(sidecar.figures[0].file, "case-s-fig1.svg");

    // 可重放：用 sidecar 的 spec + 说明书文本重跑规则，与直接用入参完全一致
    const specText = "处理模块(20)执行处理；未提及的风扇(40)。";
    const fromSidecar = checkFigures(
      sidecar.figures.map(f => f.spec),
      specText,
      { documentKind: "utility" },
    );
    const fromInput = checkFigures([FIG], specText, { documentKind: "utility" });
    assert.deepEqual(fromSidecar, fromInput);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_generate：case_id 落案卷 outputs；结构核验发现随附", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    // 图号跳号：结构核验（V1）应给 fail 发现
    const result = await tool.execute(
      {
        figures: [{ ...FIG, figure_no: 3 }],
        output_name: "bad",
        case_id: "case-1",
      },
      makeContext(cwd),
    );
    assert.ok(existsSync(join(cwd, "data", "cases", "case-1", "outputs", "bad-fig3.svg")));
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("[FAIL] V1"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_generate：非法 output_name / 空 figures fail-closed", async () => {
  const tool = createPatentFigureGenerateTool();
  const context = makeContext(tempCwd());
  await assert.rejects(tool.execute({ figures: [FIG], output_name: "../escape" }, context), /非法 output_name/u);
  await assert.rejects(tool.execute({ figures: [], output_name: "ok" }, context), /figures 不能为空/u);
});

test("patent_figure_check：ok=true 与 fail 两态文本", async () => {
  const tool = createPatentFigureCheckTool();
  const pass = await tool.execute({ figures: [FIG], spec_text: "处理模块(20)执行处理。" }, makeContext(process.cwd()));
  const passText = pass.content[0].type === "text" ? pass.content[0].text : "";
  assert.ok(passText.includes("核验通过"));
  assert.ok(passText.includes("图内标记：20"));

  const fail = await tool.execute({ figures: [FIG], spec_text: "无关文本。" }, makeContext(process.cwd()));
  const failText = fail.content[0].type === "text" ? fail.content[0].text : "";
  assert.ok(failText.includes("核验未通过"));
  assert.ok(failText.includes("[FAIL] V2"));
  assert.ok(failText.includes("细则第 21 条"));
  // 单图无"跨图"可言：不产出多图一致性小节（避免噪音）
  assert.ok(!failText.includes("多图一致性检查"));
});

test("patent_figure_check：≥2 幅自动跑多图一致性（机械件号对齐与缺漏）", async () => {
  const tool = createPatentFigureCheckTool();
  const figures: FigureSpec[] = [
    { figure_no: 1, kind: "block", nodes: [{ id: "a", label: "壳体(10)", ref: 10 }], edges: [] },
    { figure_no: 2, kind: "block", nodes: [{ id: "b", label: "盖板(20)", ref: 20 }], edges: [] },
  ];
  const ok = await tool.execute(
    { figures, spec_text: "壳体(10)与盖板(20)连接。", document_kind: "utility" },
    makeContext(process.cwd()),
  );
  const okText = ok.content[0].type === "text" ? ok.content[0].text : "";
  assert.ok(okText.includes("多图一致性检查"), "多图应附一致性小节");
  assert.ok(okText.includes("附图 2 张"));

  // 文字引用 30 但附图未识别 → missingRefs（机械数字档对齐）
  const missing = await tool.execute(
    { figures, spec_text: "壳体(10)与盖板(20)通过螺栓(30)连接。", document_kind: "utility" },
    makeContext(process.cwd()),
  );
  const missingText = missing.content[0].type === "text" ? missing.content[0].text : "";
  assert.ok(missingText.includes("30"), "应报未在附图中识别的标记 30");
  assert.ok(/未在附图中识别/u.test(missingText));
});

test("patent_figure_check：image_paths 走像素级核查，svg_paths 结构核验行为不变", async () => {
  const cwd = tempCwd();
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    // 灰度着色的栅格图（应在 PX1 报 fail），文件名未声明图号（PX4 warn）
    const shaded = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .png()
      .toFile(join(cwd, "shaded-scan.png"));
    assert.ok(shaded.width === 300);

    const tool = createPatentFigureCheckTool();
    const result = await tool.execute(
      { image_paths: ["shaded-scan.png"], spec_text: "（无结构化附图）" },
      makeContext(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("核验未通过"), "PX1 fail 应使核验判未通过");
    assert.ok(text.includes("[FAIL] PX1"));
    assert.ok(text.includes("[WARN] PX4"));
    assert.ok(text.includes("结构规则：未提供结构化附图"), "仅栅格图时如实声明结构规则不适用");

    // 回归：svg_paths 仍走结构核验（不受 image_paths 影响）
    const svgTool = createPatentFigureCheckTool();
    const svgResult = await svgTool.execute(
      { figures: [FIG], spec_text: "处理模块(20)执行处理。" },
      makeContext(process.cwd()),
    );
    const svgText = svgResult.content[0].type === "text" ? svgResult.content[0].text : "";
    assert.ok(svgText.includes("核验通过"));
    assert.ok(!svgText.includes("栅格附图像素级核查"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：claims_text/description_text 显式分面替代启发式（V10 不再依赖小节标题）", async () => {
  const tool = createPatentFigureCheckTool();
  // 文本无小节标题（启发式会分节失败），但调用方显式给出两个面
  const result = await tool.execute(
    {
      figures: [{ figure_no: 1, kind: "block", nodes: [{ id: "a", label: "壳体(10)", ref: 10 }], edges: [] }],
      spec_text: "权利要求：壳体10。正文：壳体(10)与盖板连接。",
      claims_text: "1. 一种装置，包括壳体10。",
      description_text: "壳体(10)与盖板连接。",
    },
    makeContext(process.cwd()),
  );
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.ok(text.includes("文字面分节：已分节"));
  assert.ok(text.includes("调用方显式分面"));
  assert.ok(text.includes("[FAIL] V10"), "权利要求面裸标记应判 V10");
  assert.ok(text.includes("[WARN] V11"), "正文面括号引用应判 V11");
});

test("patent_figure_check：文字面分节结论随报告输出（未分节则注明 V10/V11 未生效）", async () => {
  const tool = createPatentFigureCheckTool();
  const unsectioned = await tool.execute(
    { figures: [FIG], spec_text: "一段无小节标题的文字，提及处理模块(20)。" },
    makeContext(process.cwd()),
  );
  const text = unsectioned.content[0].type === "text" ? unsectioned.content[0].text : "";
  assert.ok(text.includes("文字面分节：未分节"));
  assert.ok(text.includes("V10/V11 未生效"));

  const sectioned = await tool.execute(
    {
      figures: [FIG],
      spec_text: [
        "## 权利要求书",
        "1. 一种装置，包括处理模块(20)。",
        "## 说明书",
        "## 具体实施方式",
        "处理模块20执行处理。",
      ].join("\n"),
    },
    makeContext(process.cwd()),
  );
  const sectionedText = sectioned.content[0].type === "text" ? sectioned.content[0].text : "";
  assert.ok(sectionedText.includes("文字面分节：已分节"));
});
