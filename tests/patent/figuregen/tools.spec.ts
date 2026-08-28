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
    assert.equal(fileBlocks.length, 1);
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
