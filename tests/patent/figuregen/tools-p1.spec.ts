/**
 * patent_figure_* 工具 P1 能力测试：A4 HTML 导出、SVG 回读复核、入参互斥校验。
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

const FIG: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "a", to: "b" }],
};

test("patent_figure_generate：format=both 额外产出 A4 打印 HTML", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-p1-"));
  try {
    const tool = createPatentFigureGenerateTool();
    const result = await tool.execute(
      { figures: [FIG], output_name: "pkg", format: "both", invention_name: "一种处理装置" },
      makeContext(cwd),
    );
    const htmlPath = join(cwd, ".sati", "figures", "pkg-figures.html");
    assert.ok(existsSync(htmlPath));
    const html = readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("@page"));
    assert.ok(html.includes("一种处理装置"));
    assert.ok(html.includes('data-ref="20"'));
    const fileBlocks = result.content.filter(block => block.type === "file");
    assert.equal(fileBlocks.length, 3, "1 个 SVG + 1 个 HTML + 1 个 sidecar");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：svg_paths 回读已交付 SVG 复核", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-p1-"));
  try {
    const generate = createPatentFigureGenerateTool();
    await generate.execute({ figures: [FIG], output_name: "deliv" }, makeContext(cwd));
    const svgPath = join(cwd, ".sati", "figures", "deliv-fig1.svg");

    const check = createPatentFigureCheckTool();
    const pass = await check.execute(
      { svg_paths: [svgPath], spec_text: "处理模块(20)对数据进行处理。" },
      makeContext(cwd),
    );
    const passText = pass.content[0].type === "text" ? pass.content[0].text : "";
    assert.ok(passText.includes("核验通过"), passText);
    assert.ok(passText.includes("图内标记：20"));

    const fail = await check.execute({ svg_paths: [svgPath], spec_text: "无关文本。" }, makeContext(cwd));
    const failText = fail.content[0].type === "text" ? fail.content[0].text : "";
    assert.ok(failText.includes("核验未通过"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：figures 与 svg_paths 均缺省 fail-closed", async () => {
  const check = createPatentFigureCheckTool();
  await assert.rejects(check.execute({ spec_text: "任意" }, makeContext(process.cwd())), /至少提供一项/u);
});

/** 横向框图：交付画幅窄而高，被核验器重排成 flowchart/TB 后画幅会大幅改变。 */
const WIDE_BLOCK: FigureSpec = {
  figure_no: 1,
  kind: "block",
  direction: "LR",
  nodes: Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, label: `模块${i + 1}` })),
  edges: [],
};

/** 超画幅的纵向流程图（≥20 节点 TB）：结构化输入下必须判 V7 fail。 */
const OVERSIZE_FLOW: FigureSpec = {
  figure_no: 2,
  kind: "flowchart",
  direction: "TB",
  nodes: Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, label: `步骤${i + 1}` })),
  edges: Array.from({ length: 19 }, (_, i) => ({ from: `b${i}`, to: `b${i + 1}` })),
};

test("patent_figure_check：svg_paths 回读不按重排画幅判 V7（交付画幅不可由此推断）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-p1-"));
  try {
    const generate = createPatentFigureGenerateTool();
    await generate.execute({ figures: [WIDE_BLOCK], output_name: "wide" }, makeContext(cwd));

    const check = createPatentFigureCheckTool();
    const result = await check.execute(
      { svg_paths: [join(cwd, ".sati", "figures", "wide-fig1.svg")], spec_text: "本案涉及一种装置。" },
      makeContext(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(
      !text.includes("V7"),
      `回读骨架的画幅由交付文件决定，不得由核验器重排后判定（重排会量出交付物上不存在的尺寸）：\n${text}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：混合输入时逐图排除——结构化附图照判 V7，回读骨架不判", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-p1-"));
  try {
    const generate = createPatentFigureGenerateTool();
    await generate.execute({ figures: [WIDE_BLOCK], output_name: "wide" }, makeContext(cwd));

    const check = createPatentFigureCheckTool();
    const result = await check.execute(
      {
        figures: [OVERSIZE_FLOW],
        svg_paths: [join(cwd, ".sati", "figures", "wide-fig1.svg")],
        spec_text: "本案涉及一种装置。",
        figure_count: 2,
      },
      makeContext(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    // 排除必须逐图生效：图2 是结构化输入（画幅由本模块布局决定）⇒ 照判；
    // 图1 是回读骨架（画幅来自交付文件）⇒ 不判。整体跳过会让结构化那幅漏判。
    assert.match(text, /\[FAIL\] V7: 图2 /u, `结构化输入的超画幅附图必须照判 V7：\n${text}`);
    assert.ok(!/\[FAIL\] V7: 图1 /u.test(text), `回读骨架不得被判画幅：\n${text}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
