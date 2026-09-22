/**
 * 制图工具的法域/图幅/页码/落版接线测试（W1-6 / W1-7）。
 *
 * 覆盖"工具层把法域档案的结论落到产物上"这条链：图号条件化（pct/us 单幅不得出现 Fig./FIG.）、
 * 落版页产出与 sidecar 摘要、以及 patent_figure_check 的**图号观测**（V15/V16 只有观测到
 * 交付形态才判）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseFigureSvg } from "../../../src/patent/figuregen/readback.js";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import type { SatiToolResultContent, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-offices",
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
    { id: "start", label: "开始", shape: "ellipse" },
    { id: "step", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "start", to: "step" }],
};

function textOf(result: { content: readonly SatiToolResultContent[] }): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

test("patent_figure_generate：pct/us 单幅不标注图号；声明 figure_count=2 后按档案写法标注", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-offices-gen-"));
  try {
    const tool = createPatentFigureGenerateTool();
    for (const [jurisdiction, expected] of [
      ["pct", "Fig. 1"],
      ["us", "FIG. 1"],
      ["cn", "图1"],
    ] as const) {
      const single = await tool.execute(
        { figures: [FIG], output_name: `${jurisdiction}-one`, output_dir: dir, jurisdiction },
        makeContext(dir),
      );
      const singleSvg = readFileSync(join(dir, `${jurisdiction}-one-fig1.svg`), "utf8");
      if (jurisdiction === "cn") {
        assert.match(singleSvg, /<text[^>]*>图1<\/text>/u, "CN 单幅保留图号");
      } else {
        assert.doesNotMatch(singleSvg, /FIG\.|Fig\./u, `${jurisdiction} 单幅不得出现 Fig./FIG.`);
        assert.equal(parseFigureSvg(singleSvg).figureNo, 1, "图号仍可由 data-figure-no 回读");
      }
      assert.match(textOf(single), /不标注图号|标注在图形正下方/u);

      const multi = await tool.execute(
        { figures: [FIG], output_name: `${jurisdiction}-multi`, output_dir: dir, jurisdiction, figure_count: 2 },
        makeContext(dir),
      );
      const multiSvg = readFileSync(join(dir, `${jurisdiction}-multi-fig1.svg`), "utf8");
      assert.ok(multiSvg.includes(`>${expected}<`), `多幅时 ${jurisdiction} 图号应为 ${expected}`);
      assert.match(textOf(multi), new RegExp(expected.replace(".", "\\."), "u"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patent_figure_generate：fit_to_page 产落版页、sidecar 记 office/caption/sheet/layout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-offices-page-"));
  try {
    const tool = createPatentFigureGenerateTool();
    const result = await tool.execute(
      {
        figures: [FIG],
        output_name: "paged",
        output_dir: dir,
        jurisdiction: "pct",
        figure_count: 2,
        fit_to_page: true,
        sheet_index: 1,
        sheet_total: 3,
      },
      makeContext(dir),
    );
    assert.match(textOf(result), /提交落版页/u);

    const pagePath = join(dir, "paged-fig1-page.svg");
    const page = readFileSync(pagePath, "utf8");
    assert.match(page, /width="210mm" height="297mm"/u);
    assert.ok(page.includes(">1/3<"), "PCT 页码体例为 1/3");
    // 落版页可回读（figure-gate 的漂移检测因此对落版页同样有效）
    assert.equal(parseFigureSvg(page).figureNo, 1);

    const sidecar = JSON.parse(readFileSync(join(dir, "paged-figures.json"), "utf8")) as {
      version: number;
      office?: string;
      figures: {
        caption?: string;
        sheet?: { index: number; total: number; text: string };
        layout?: { file: string; page_scale: number };
      }[];
    };
    assert.equal(sidecar.version, 1, "新增可选字段不升版本（旧 sidecar 仍可解析）");
    assert.equal(sidecar.office, "pct");
    assert.equal(sidecar.figures[0]?.caption, "Fig. 1");
    assert.deepEqual(sidecar.figures[0]?.sheet, { index: 1, total: 3, text: "1/3" });
    assert.equal(sidecar.figures[0]?.layout?.file, "paged-fig1-page.svg");
    assert.ok((sidecar.figures[0]?.layout?.page_scale ?? 0) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patent_figure_generate：sheet_index/sheet_total 须成对且序号不越界", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-offices-sheet-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await assert.rejects(
      tool.execute({ figures: [FIG], output_name: "bad-sheet", output_dir: dir, sheet_total: 3 }, makeContext(dir)),
      /须成对给出/u,
    );
    await assert.rejects(
      tool.execute(
        { figures: [FIG], output_name: "bad-range", output_dir: dir, sheet_index: 5, sheet_total: 3 },
        makeContext(dir),
      ),
      /超出 sheet_total/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patent_figure_check：svg_paths 观测图号 → 多幅缺号判 V15、单幅带号判 V16", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-offices-check-"));
  try {
    const generate = createPatentFigureGenerateTool();
    const check = createPatentFigureCheckTool();

    // 两幅 us 图（单幅形态渲染 ⇒ 都不带图号），声明共 2 幅 ⇒ V15 fail
    await generate.execute(
      {
        figures: [
          FIG,
          {
            ...FIG,
            figure_no: 2,
            nodes: [
              { id: "a", label: "开始" },
              { id: "b", label: "结束" },
            ],
            edges: [],
          },
        ],
        output_name: "missing-number",
        output_dir: dir,
        jurisdiction: "us",
        figure_count: 1,
      },
      makeContext(dir),
    );
    const v15 = await check.execute(
      {
        svg_paths: ["missing-number-fig1.svg", "missing-number-fig2.svg"],
        spec_text: "处理模块(20)为处理模块。",
        jurisdiction: "us",
        figure_count: 2,
      },
      makeContext(dir),
    );
    assert.match(textOf(v15), /\[FAIL\] V15/u);
    assert.match(textOf(v15), /图号观测（已交付 SVG）：均无图号标注/u);

    // 单幅图手工加上 FIG. 1 ⇒ V16 warn（pct/us 单幅不得出现图号）
    const singlePath = join(dir, "single-fig1.svg");
    const source = readFileSync(join(dir, "missing-number-fig1.svg"), "utf8");
    writeFileSync(singlePath, source.replace("</svg>", '<text x="10" y="10">FIG. 1</text></svg>'), "utf8");
    const v16 = await check.execute(
      { svg_paths: ["single-fig1.svg"], spec_text: "处理模块(20)为处理模块。", jurisdiction: "us", figure_count: 1 },
      makeContext(dir),
    );
    assert.match(textOf(v16), /\[WARN\] V16/u);
    assert.match(textOf(v16), /图1 带图号/u);

    // 同一份图在 CN 下不判 V16（指南 4.3 未禁止单幅编号）
    const cn = await check.execute(
      { svg_paths: ["single-fig1.svg"], spec_text: "处理模块(20)为处理模块。", figure_count: 1 },
      makeContext(dir),
    );
    assert.doesNotMatch(textOf(cn), /V16/u);
    // 结构化 figures（无交付文件可观测）也不判编号规则
    const structured = await check.execute(
      { figures: [FIG], spec_text: "处理模块(20)为处理模块。", figure_count: 2 },
      makeContext(dir),
    );
    assert.doesNotMatch(textOf(structured), /V15|V16/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patent_figure_check：pct 报告如实声明未适用 CN 括号规则、依据改为 PCT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-offices-pct-"));
  try {
    const check = createPatentFigureCheckTool();
    const result = await check.execute(
      {
        figures: [FIG],
        spec_text: "1. 一种装置，包括处理模块20。",
        claims_text: "1. 一种装置，包括处理模块20。",
        jurisdiction: "pct",
      },
      makeContext(dir),
    );
    const text = textOf(result);
    assert.match(text, /括号规则：pct 未适用 CN 括号规则/u);
    assert.match(text, /Basis: PCT Rule 11\.5\/11\.6\/11\.13/u);
    assert.doesNotMatch(text, /\[FAIL\] V10/u, "pct 下不得出现 V10 级发现");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
