/**
 * src/patent/figuregen/submission-sheet — 提交拼版页测试（多视图共页的 A4 整页）。
 *
 * 覆盖四条硬要求：
 * 1. **多视图拼版产出**，且各格按**同一**缩放系数落版（同页字高一致）；
 * 2. **单视图路径逐字节不变**（不产拼版页；落版页与既有单图落版页一致）；
 * 3. 拼版后字高低于法域下限 ⇒ **如实报出**（不静默、不假装通过）；
 * 4. 页码 / 图号体例**沿用法域档案**（本模块不自行解释编号规则）。
 *
 * 真机用例（无 FreeCAD 自动 skip）：**跳过表示「无信号」，不是「通过」**——CI 未装
 * FreeCAD ⇒ 真机链路在 CI 上没有信号，须靠本地真机跑（见
 * `docs/notes/implemented/2026-11-12-figure-dsh-alignment-batch-c.md` 的探针记录）。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CAD_JSON_BEGIN,
  CAD_JSON_END,
  CAD_VIEWS_ENV,
  cadRefFontMm,
  resolveFreecadCmd,
  type CadRunner,
} from "../../../src/patent/figuregen/cad/index.js";
import {
  writeSubmissionPageArtifact,
  writeSubmissionSheetArtifact,
} from "../../../src/patent/figuregen/deliverables.js";
import { figureCaption, officeProfile, printableArea } from "../../../src/patent/figuregen/office-profile.js";
import { parseFigureSidecar } from "../../../src/patent/figuregen/sidecar.js";
import { buildSubmissionSheet, type SubmissionSheetCell } from "../../../src/patent/figuregen/submission-sheet.js";
import { createPatentFigureProjectTool } from "../../../src/tool/builtin/patentFigureProject.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

/** 一个纯黑白的小图（毫米画幅），用于拼版排布计算。 */
function figureSvg(widthMm: number, heightMm: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(widthMm)}mm" height="${String(heightMm)}mm" ` +
    `viewBox="0 0 ${String(widthMm)} ${String(heightMm)}" font-family="sans-serif">\n` +
    `<rect x="1" y="1" width="${String(widthMm - 2)}" height="${String(heightMm - 2)}" fill="#FFFFFF" ` +
    `stroke="#000000" stroke-width="0.5"/>\n</svg>\n`
  );
}

/** 三格视图（尺寸各异 ⇒ 逐格独立缩放会得到不同字高）。 */
const CELLS: SubmissionSheetCell[] = [
  { view: "front", svg: figureSvg(120, 90), widthMm: 120, heightMm: 90 },
  { view: "top", svg: figureSvg(150, 60), widthMm: 150, heightMm: 60 },
  { view: "right", svg: figureSvg(90, 120), widthMm: 90, heightMm: 120 },
];

test("拼版：多视图排进一张 A4，各格按同一缩放系数（统一字高）", () => {
  const sheet = buildSubmissionSheet({ cells: CELLS, office: "cnipa", sourceCharHeightMm: 3 });
  assert.equal(sheet.metrics.placements.length, 3, "三格都在");
  for (const placement of sheet.metrics.placements) {
    const cell = CELLS.find(item => item.view === placement.view);
    assert.ok(cell, "落位应对应到某个视图");
    assert.ok(
      Math.abs(placement.widthMm / (cell?.widthMm ?? 1) - sheet.metrics.pageScale) < 1e-9,
      `${placement.view} 的宽缩放应等于统一系数`,
    );
    assert.ok(
      Math.abs(placement.heightMm / (cell?.heightMm ?? 1) - sheet.metrics.pageScale) < 1e-9,
      `${placement.view} 的高缩放应等于统一系数`,
    );
  }
  // 字高只跟统一系数走（各格一致 ⇒ 同页字高一致）。
  assert.ok(Math.abs(sheet.metrics.charHeightMm - 3 * sheet.metrics.pageScale) < 1e-9);
  assert.ok(sheet.metrics.pageScale <= 1, "统一缩放系数恒 ≤ 1（不放大）");
  // 网格自洽：列 × 行能装下全部格。
  assert.ok(sheet.metrics.columns * sheet.metrics.rows >= CELLS.length);
  assert.equal(sheet.metrics.placements.length, CELLS.length);
  // 页面里确实嵌了三张图。
  assert.equal((sheet.svg.match(/<svg x="/gu) ?? []).length, CELLS.length);
});

test("拼版：网格按'统一缩放系数最大'择优（可辨性优先于形状）", () => {
  // 三个大图：2 列 × 2 行的单格比 1 列 × 3 行宽 ⇒ 缩放系数更大 ⇒ 选 2 列。
  const big: SubmissionSheetCell[] = [
    { view: "a", svg: figureSvg(200, 250), widthMm: 200, heightMm: 250 },
    { view: "b", svg: figureSvg(200, 250), widthMm: 200, heightMm: 250 },
    { view: "c", svg: figureSvg(200, 250), widthMm: 200, heightMm: 250 },
  ];
  const sheet = buildSubmissionSheet({ cells: big, office: "cnipa", sourceCharHeightMm: 3 });
  assert.equal(sheet.metrics.columns, 2, "3 格大图 ⇒ 2 列（单格更大 ⇒ 缩放系数更大）");
  assert.equal(sheet.metrics.rows, 2);
  const area = printableArea(officeProfile("cnipa"));
  assert.ok(sheet.metrics.cellWidthMm < area.widthMm, "单格可用区小于整页版心");
  // 系数按**单格**可用区算（不是按整页版心）⇒ 系数不会虚高。
  assert.ok(sheet.metrics.pageScale < 1);
});

test("拼版：字高低于法域下限时如实报出（不静默、不假装通过）", () => {
  // 超大图 ⇒ 必须缩小 ⇒ 字高跌破法域下限。
  const huge: SubmissionSheetCell[] = [
    { view: "a", svg: figureSvg(400, 500), widthMm: 400, heightMm: 500 },
    { view: "b", svg: figureSvg(400, 500), widthMm: 400, heightMm: 500 },
  ];
  const sheet = buildSubmissionSheet({ cells: huge, office: "cnipa", sourceCharHeightMm: 3 });
  assert.equal(sheet.metrics.charHeightCompliant, false, "字高不合规必须如实标记");
  assert.ok(
    sheet.warnings.some(warning => warning.includes("字高")),
    `应报出字高告警，实际：${sheet.warnings.join(" / ")}`,
  );
  assert.ok(sheet.metrics.minCharHeightMm !== undefined, "下限取自法域档案");
  // 缩小本身的告警也要有（读者要知道自己交出去的是缩小的页）。
  assert.ok(sheet.warnings.some(warning => warning.includes("统一缩放系数")));

  // PCT 有条文下限（3.2mm）⇒ 同一张拼版页按 PCT 判据仍不合规。
  const pct = buildSubmissionSheet({ cells: huge, office: "pct", sourceCharHeightMm: 3.5 });
  assert.equal(pct.metrics.minCharHeightBasis, "statute");
  assert.equal(pct.metrics.charHeightCompliant, false);
});

test("拼版：字高达标时不报字高告警", () => {
  const sheet = buildSubmissionSheet({ cells: CELLS, office: "cnipa", sourceCharHeightMm: 3 });
  assert.equal(sheet.metrics.charHeightCompliant, true);
  assert.ok(!sheet.warnings.some(warning => warning.includes("低于")), sheet.warnings.join(" / "));
});

test("拼版：页码体例沿用法域档案（CN 顺序数字，PCT/US 分数）", () => {
  const cn = buildSubmissionSheet({ cells: CELLS, office: "cnipa", sheetIndex: 2, sheetTotal: 3 });
  assert.ok(cn.svg.includes(">2</text>"), "CN 页码为顺序阿拉伯数字");
  const pct = buildSubmissionSheet({ cells: CELLS, office: "pct", sheetIndex: 2, sheetTotal: 3 });
  assert.ok(pct.svg.includes(">2/3</text>"), "PCT 页码为斜线分数");
  const uspto = buildSubmissionSheet({ cells: CELLS, office: "uspto", sheetIndex: 1, sheetTotal: 3 });
  assert.ok(uspto.svg.includes(">1/3</text>"), "US 页码为斜线分数");
});

test("拼版：图号由调用方给出（本模块不解释编号规则），落在各格下方", () => {
  const profile = officeProfile("cnipa");
  const caption = figureCaption(profile, 2, 3);
  assert.equal(caption, "图2", "图号文本取自档案");
  const sheet = buildSubmissionSheet({
    cells: CELLS.map(cell => ({ ...cell, caption })),
    office: "cnipa",
    sourceCharHeightMm: 3,
  });
  // 每格一条图号，且都在该格的图下方（y 大于该格图的下沿）。
  const captions = [...sheet.svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/gu)].filter(
    match => match[3] === "图2",
  );
  assert.equal(captions.length, CELLS.length, "每格一条图号");
  const nested = [...sheet.svg.matchAll(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/gu)];
  assert.equal(nested.length, CELLS.length);
  captions.forEach((captionMatch, index) => {
    const box = nested[index];
    assert.ok(box, "每格图有定位");
    const captionY = Number(captionMatch[2]);
    const boxBottom = Number(box[2]) + Number(box[4]);
    assert.ok(captionY > boxBottom, "图号在图下方");
    assert.ok(Math.abs(Number(captionMatch[1]) - (Number(box[1]) + Number(box[3]) / 2)) < 0.05, "图号居中于本格");
  });

  // 档案体例：PCT / US 的图号写法由档案给出，本模块原样落。
  const pctCaption = figureCaption(officeProfile("pct"), 2, 3);
  assert.equal(pctCaption, "Fig. 2");
  const pct = buildSubmissionSheet({
    cells: CELLS.map(cell => ({ ...cell, caption: pctCaption })),
    office: "pct",
  });
  assert.ok(pct.svg.includes(">Fig. 2</text>"));
});

test("拼版：黑白不变式（不引入彩色）", () => {
  const sheet = buildSubmissionSheet({
    cells: CELLS.map(cell => ({ ...cell, caption: "图1" })),
    office: "cnipa",
    sheetIndex: 1,
    sheetTotal: 1,
  });
  const colors = (sheet.svg.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).map(color => color.toUpperCase());
  assert.ok(
    colors.every(color => ["#000000", "#FFFFFF"].includes(color)),
    `拼版页只允许黑白：${colors.join("、")}`,
  );
});

test("拼版：产出是合法 XML（根 <svg> 开始标签带闭合符，严格渲染器能打开）", () => {
  const sheet = buildSubmissionSheet({ cells: CELLS, office: "cnipa", sourceCharHeightMm: 3 });
  const rootStart = sheet.svg.indexOf("<svg");
  const rootEnd = sheet.svg.indexOf(">", rootStart);
  const firstChild = sheet.svg.indexOf("<", rootStart + 1);
  assert.ok(rootStart >= 0 && rootEnd > rootStart, "拼版页应有 <svg> 根元素");
  assert.ok(rootEnd < firstChild, "根 <svg> 开始标签必须以 > 结束（否则不是合法 XML）");
  // 开闭标签配平。
  assert.equal(
    (sheet.svg.match(/<svg\b/gu) ?? []).length,
    (sheet.svg.match(/<\/svg>/gu) ?? []).length,
    "<svg> 与 </svg> 必须配平",
  );
});

// ---------------------------------------------------------------------------
// CAD 通路接线（假 runner ⇒ 不真跑 FreeCAD）
// ---------------------------------------------------------------------------

/** 矩形轮廓（四条边）——够渲染出一张有内容的图。 */
const RECT = [
  [
    [0, 0],
    [40, 0],
  ],
  [
    [40, 0],
    [40, 30],
  ],
  [
    [40, 30],
    [0, 30],
  ],
  [
    [0, 30],
    [0, 0],
  ],
] as const;

/**
 * 各视图的投影坐标轴像。
 *
 * 必须与视图方向相容：屏幕右轴/上轴在该视图的投影平面上不能退化（否则渲染器报
 * "投影坐标系无法对齐"）。front 的投影平面是 XZ、top 是 XY、right 是 YZ ⇒ 视线方向的
 * 那根轴在平面上退化为一点，其余两根给出平面内的正交像。
 */
const VIEW_AXES: Record<
  string,
  { origin: [number, number]; x: [number, number]; y: [number, number]; z: [number, number] }
> = {
  front: { origin: [0, 0], x: [0, 1], y: [0, 0], z: [-1, 0] },
  top: { origin: [0, 0], x: [1, 0], y: [0, 1], z: [0, 0] },
  right: { origin: [0, 0], x: [0, 0], y: [1, 0], z: [0, 1] },
};

function viewPayload(view: string): Record<string, unknown> {
  return {
    view,
    units: "mm",
    axes: VIEW_AXES[view],
    edges: RECT.map((points, index) => ({
      kind: "visible",
      curve: "Line",
      closed: index === 3,
      points: points.map(point => [point[0], point[1]]),
    })),
    curveKinds: { Line: 4 },
  };
}

/** 多视图载荷（v3：一次投影产出全部视图）。 */
function payloadOf(views: readonly string[]): Record<string, unknown> {
  return {
    version: 3,
    views: views.map(view => viewPayload(view)),
    parts: [
      {
        index: 0,
        bbox: { min: [0, 0, 0], max: [40, 30, 10] },
        centroid: [20, 15, 5],
        area: 3800,
        volume: 12000,
        views: {
          front: {
            projectedBBox: { min: [0, 0], max: [40, 30] },
            suggestedAnchor: [0, 0, 0],
            suggestedAnchorProjected: [0, 0],
          },
        },
      },
    ],
    anchors: [],
  };
}

function runnerOf(payload: Record<string, unknown>): CadRunner {
  return async () => ({
    stdout: `FreeCAD 1.1.3 banner\n${CAD_JSON_BEGIN}\n${JSON.stringify(payload)}\n${CAD_JSON_END}\nstats`,
    stderr: "",
    code: 0,
  });
}

/** 多视图假运行器（front + top + right）。 */
function multiViewRunner(): CadRunner {
  return runnerOf(payloadOf(["front", "top", "right"]));
}

/** 单视图假运行器（只有 front）——单视图路径的回归对照。 */
function singleViewRunner(): CadRunner {
  return runnerOf(payloadOf(["front"]));
}

function context(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-sheet",
    turnId: "turn-sheet",
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

test("CAD 多视图：产出拼版页，sidecar 记 sheet_layout（layout 仍是单图语义）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sheet-"));
  const original = process.env[CAD_VIEWS_ENV];
  try {
    process.env[CAD_VIEWS_ENV] = "top,right";
    const tool = createPatentFigureProjectTool({ runner: multiViewRunner(), freecadCmd: "/fake/freecadcmd" });
    const result = await tool.execute(
      {
        step_path: "plate.step",
        output_name: "case-sheet",
        view: "front",
        figure_no: 2,
        figure_count: 3,
        fit_to_page: true,
        sheet_index: 1,
        sheet_total: 3,
      },
      context(cwd),
    );
    const dir = join(cwd, ".sati", "figures");
    // 三张视图 SVG + 一张落版页 + 一张拼版页。
    assert.ok(existsSync(join(dir, "case-sheet-fig2-front.svg")));
    assert.ok(existsSync(join(dir, "case-sheet-fig2-top.svg")));
    assert.ok(existsSync(join(dir, "case-sheet-fig2-right.svg")));
    assert.ok(existsSync(join(dir, "case-sheet-fig2-page.svg")), "单图落版页照旧产出");
    const sheetPath = join(dir, "case-sheet-fig2-sheet.svg");
    assert.ok(existsSync(sheetPath), "多视图 ⇒ 产出拼版页");

    const sidecar = parseFigureSidecar(readFileSync(join(dir, "case-sheet-figures.json"), "utf8"));
    const figure = sidecar.figures[0];
    assert.ok(figure, "sidecar 记主视图");
    assert.ok(figure.layout, "layout 仍是单图落版语义");
    assert.ok(figure.sheet_layout, "拼版页信息走新增字段");
    const sheetLayout = figure.sheet_layout!;
    assert.equal(sheetLayout.cells, 3, "三格");
    assert.equal(sheetLayout.file, "case-sheet-fig2-sheet.svg");
    assert.ok(sheetLayout.columns * sheetLayout.rows >= 3);
    assert.ok(sheetLayout.page_scale > 0 && sheetLayout.page_scale <= 1);
    assert.equal(sheetLayout.placements.length, 3);
    assert.deepEqual(
      sheetLayout.placements.map(item => item.view),
      ["front", "top", "right"],
      "落格顺序即视图序（阅读序）",
    );
    // 逐格落版尺寸与统一系数自洽。
    for (const placement of sheetLayout.placements) {
      assert.ok(placement.width_mm > 0 && placement.height_mm > 0);
    }

    // 报告里如实给出拼版页路径与字高核验结论。
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /提交拼版页/u);
    assert.match(text, /拼版后图内字高/u);
    assert.match(text, /统一缩放/u);
  } finally {
    if (original === undefined) delete process.env[CAD_VIEWS_ENV];
    else process.env[CAD_VIEWS_ENV] = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("CAD 单视图：路径不变——不产拼版页，落版页与既有单图落版页逐字节一致", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sheet-single-"));
  const reference = mkdtempSync(join(tmpdir(), "sati-sheet-ref-"));
  const original = process.env[CAD_VIEWS_ENV];
  try {
    delete process.env[CAD_VIEWS_ENV];
    const tool = createPatentFigureProjectTool({ runner: singleViewRunner(), freecadCmd: "/fake/freecadcmd" });
    await tool.execute(
      {
        step_path: "plate.step",
        output_name: "case-single",
        view: "front",
        figure_no: 2,
        figure_count: 3,
        fit_to_page: true,
        sheet_index: 1,
        sheet_total: 3,
      },
      context(cwd),
    );
    const dir = join(cwd, ".sati", "figures");
    assert.ok(existsSync(join(dir, "case-single-fig2.svg")), "单视图仍是既有命名");
    assert.ok(existsSync(join(dir, "case-single-fig2-page.svg")), "单视图走既有单图落版页");
    assert.ok(!existsSync(join(dir, "case-single-fig2-sheet.svg")), "单视图不产拼版页（默认路径零变化）");

    // 逐字节：与直接调既有单图落版页封装产出的文件完全一致。
    await writeSubmissionPageArtifact({
      outputDir: reference,
      outputName: "case-single",
      figureNo: 2,
      drawingSvg: readFileSync(join(dir, "case-single-fig2.svg"), "utf8"),
      office: "cnipa",
      sheet: { index: 1, total: 3 },
      sourceCharHeightMm: cadRefFontMm("cn"),
    });
    assert.equal(
      readFileSync(join(dir, "case-single-fig2-page.svg"), "utf8"),
      readFileSync(join(reference, "case-single-fig2-page.svg"), "utf8"),
      "单视图落版页必须逐字节不变",
    );
  } finally {
    if (original === undefined) delete process.env[CAD_VIEWS_ENV];
    else process.env[CAD_VIEWS_ENV] = original;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(reference, { recursive: true, force: true });
  }
});

test("拼版页落盘封装：文件名与 sidecar 摘要字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-sheet-artifact-"));
  try {
    const artifact = await writeSubmissionSheetArtifact({
      outputDir: dir,
      outputName: "figs",
      figureNo: 3,
      cells: CELLS,
      office: "cnipa",
      sheet: { index: 1, total: 2 },
      sourceCharHeightMm: cadRefFontMm("cn"),
    });
    assert.equal(artifact.path, resolve(dir, "figs-fig3-sheet.svg"));
    assert.equal(artifact.layout.file, "figs-fig3-sheet.svg");
    assert.equal(artifact.layout.cells, 3);
    assert.equal(artifact.layout.char_height_compliant, true);
    assert.ok(existsSync(artifact.path));
    const svg = readFileSync(artifact.path, "utf8");
    assert.ok(svg.includes('data-figure-no="3"'), "拼版页根元素带图号（可回读）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 真机集成（无 FreeCAD 自动 skip —— 跳过表示「无信号」，不是「通过」）
// ---------------------------------------------------------------------------

const FREECAD = resolveFreecadCmd();

/** 用 FreeCAD 造一个含 2 个 solid 的 STEP（exportStep 才有几何；Part.export 会写空壳）。 */
function makeTwoSolidStep(dir: string): string {
  const scriptPath = join(dir, "make.py");
  const stepPath = join(dir, "two-solids.step");
  writeFileSync(
    scriptPath,
    [
      "import FreeCAD as App",
      "import Part",
      "a = Part.makeBox(40, 30, 10, App.Vector(0, 0, 0))",
      "b = Part.makeBox(20, 20, 25, App.Vector(10, 5, 0))",
      "comp = Part.makeCompound([a, b])",
      `comp.exportStep(${JSON.stringify(stepPath)})`,
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync(FREECAD!.cmd, [scriptPath]);
  return stepPath;
}

test("真机：多视图 ⇒ 拼版页产出（各格统一缩放、字高达标）（无 FreeCAD 自动 skip）", {
  skip: FREECAD === undefined ? "freecadcmd not installed" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-sheet-real-"));
  const original = process.env[CAD_VIEWS_ENV];
  try {
    const stepPath = makeTwoSolidStep(dir);
    process.env[CAD_VIEWS_ENV] = "top,right";
    const tool = createPatentFigureProjectTool({ freecadCmd: FREECAD!.cmd });
    await tool.execute(
      {
        step_path: stepPath,
        output_name: "case-real",
        view: "front",
        figure_no: 1,
        figure_count: 1,
        fit_to_page: true,
        sheet_index: 1,
        sheet_total: 1,
      },
      context(dir),
    );
    const outDir = join(dir, ".sati", "figures");
    const sheetPath = join(outDir, "case-real-fig1-sheet.svg");
    assert.ok(existsSync(sheetPath), "真机多视图 ⇒ 拼版页产出");
    const sidecar = parseFigureSidecar(readFileSync(join(outDir, "case-real-figures.json"), "utf8"));
    const sheetLayout = sidecar.figures[0]?.sheet_layout;
    assert.ok(sheetLayout, "sidecar 记拼版摘要");
    assert.equal(sheetLayout.cells, 3);
    // 统一缩放：各格纸面尺寸 / 图面尺寸 = 同一系数。
    const viewSvgs = ["front", "top", "right"].map(view => ({
      view,
      svg: readFileSync(join(outDir, `case-real-fig1-${view}.svg`), "utf8"),
    }));
    for (const placement of sheetLayout.placements) {
      const source = viewSvgs.find(item => item.view === placement.view);
      assert.ok(source, `视图 ${placement.view} 的 SVG 存在`);
      const match = source.svg.match(/width="([\d.]+)mm" height="([\d.]+)mm"/u);
      assert.ok(match, "视图 SVG 声明纸面尺寸");
      assert.ok(
        Math.abs(Number(match[1]) * sheetLayout.page_scale - placement.width_mm) < 0.05,
        `${placement.view} 的落版宽应等于图面宽 × 统一系数`,
      );
    }
    assert.equal(sheetLayout.char_height_compliant, true, "真机默认字号下字高达标");
  } finally {
    if (original === undefined) delete process.env[CAD_VIEWS_ENV];
    else process.env[CAD_VIEWS_ENV] = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
