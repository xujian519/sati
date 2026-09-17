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
});
