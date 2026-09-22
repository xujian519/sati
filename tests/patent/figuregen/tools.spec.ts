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
import type {
  ChartLineStyle,
  ChartMarker,
  FigureKind,
  FigureNodeShape,
  FigureSpec,
} from "../../../src/patent/figuregen/types.js";
import {
  CHART_LINE_STYLES,
  CHART_MARKERS,
  FIGURE_INPUT_SCHEMA_REF,
  FIGURE_KINDS,
} from "../../../src/tool/builtin/patentFigureSchema.js";

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

/** 曲线图（矢量通路）：nodes/edges 留空数组，数据在 chart 字段。 */
const CHART: FigureSpec = {
  figure_no: 1,
  kind: "chart",
  nodes: [],
  edges: [],
  chart: {
    x: { title: "温度(℃)", min: 20, max: 80 },
    y: { title: "转化率(%)" },
    series: [
      {
        name: "实施例1",
        points: [
          [20, 4],
          [50, 58],
          [80, 96],
        ],
        marker: "filled-circle",
      },
      {
        name: "对比例1",
        points: [
          [20, 2],
          [50, 22],
          [80, 41],
        ],
        marker: "filled-triangle",
        line: "dashed",
      },
    ],
  },
};

test("patent_figure_generate：曲线图落盘（空 nodes 合法）+ 附图说明写「曲线图」", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    const result = await tool.execute(
      { figures: [CHART], output_name: "case-chart", invention_name: "一种催化剂性能测试方法" },
      makeContext(cwd),
    );
    const svg = readFileSync(join(cwd, ".sati", "figures", "case-chart-fig1.svg"), "utf8");
    assert.ok(svg.includes("<polyline"), "应有数据折线");
    assert.ok(svg.includes(">温度(℃)</text>"), "应有横轴标目");
    assert.ok(svg.includes(">实施例1</text>"), "应有图例");
    assert.ok(svg.includes('data-figure-no="1"'));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("曲线图"), text);
    assert.ok(text.includes("一种催化剂性能测试方法的曲线图"), text);

    // sidecar 无损：chart 载荷逐字段保留（供 patent_figure_check 与附图门禁重放）
    const sidecar = parseFigureSidecar(readFileSync(join(cwd, ".sati", "figures", "case-chart-figures.json"), "utf8"));
    assert.deepEqual(sidecar.figures[0]!.spec, CHART);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_generate：曲线图 + graphviz 通路 fail-loud（不落盘半成品）", async () => {
  const cwd = tempCwd();
  const previous = process.env.SATI_FIGURE_RENDERER;
  process.env.SATI_FIGURE_RENDERER = "graphviz-wasm";
  try {
    const tool = createPatentFigureGenerateTool();
    await assert.rejects(
      tool.execute({ figures: [CHART], output_name: "case-chart-wasm" }, makeContext(cwd)),
      /曲线图.*无法绘制/u,
    );
    assert.equal(existsSync(join(cwd, ".sati", "figures", "case-chart-wasm-fig1.svg")), false, "不得留下半成品");
  } finally {
    if (previous === undefined) delete process.env.SATI_FIGURE_RENDERER;
    else process.env.SATI_FIGURE_RENDERER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("入参结构性校验：曲线图缺 chart/空 series/畸形数据点/缺轴标目一律 fail-closed", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    const base = { x: { title: "t(s)" }, y: { title: "y" }, series: [{ points: [[0, 0]] }] };
    const cases: { chart: unknown; pattern: RegExp }[] = [
      { chart: undefined, pattern: /缺少 chart 数据/u },
      { chart: { ...base, series: [] }, pattern: /series 不能为空/u },
      { chart: { ...base, series: [{ points: [] }] }, pattern: /没有数据点/u },
      { chart: { ...base, series: [{ points: [[0]] }] }, pattern: /不是 \[x, y\] 两个有限数/u },
      { chart: { ...base, series: [{ points: [[0, "1"]] }] }, pattern: /不是 \[x, y\] 两个有限数/u },
      { chart: { ...base, y: { title: "  " } }, pattern: /y 轴缺少标目/u },
    ];
    for (const { chart, pattern } of cases) {
      const figure = { ...CHART, chart } as unknown as FigureSpec;
      await assert.rejects(
        tool.execute({ figures: [figure], output_name: "case-bad" }, makeContext(cwd)),
        pattern,
        `未拦下：${JSON.stringify(chart)}`,
      );
    }
    // 空 nodes 的非曲线图仍被拦（既有不变式不因曲线图放宽而失效）
    await assert.rejects(
      tool.execute(
        { figures: [{ figure_no: 1, kind: "flowchart", nodes: [], edges: [] }], output_name: "case-empty" },
        makeContext(cwd),
      ),
      /nodes 不能为空/u,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：曲线图入参同样 fail-closed（不只 generate 拦）", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureCheckTool();
    await assert.rejects(
      tool.execute(
        {
          figures: [{ ...CHART, chart: { x: { title: "" }, y: { title: "y" }, series: [{ points: [[0, 0]] }] } }],
          spec_text: "",
        },
        makeContext(cwd),
      ),
      /x 轴缺少标目/u,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

const STATE: FigureSpec = {
  figure_no: 1,
  kind: "state",
  nodes: [
    { id: "s0", label: "", shape: "circle" },
    { id: "idle", label: "待机(10)", ref: 10, shape: "round" },
    { id: "sf", label: "", shape: "doublecircle" },
  ],
  edges: [
    { from: "s0", to: "idle" },
    { from: "idle", to: "sf", label: "完成" },
  ],
};

test("patent_figure_generate：状态图/层级图端到端（落盘 + sidecar 无损 + 措辞）", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    const hierarchy: FigureSpec = {
      figure_no: 2,
      kind: "hierarchy",
      nodes: [
        { id: "sys", label: "系统(1)", ref: 1 },
        { id: "mod", label: "模块(10)", ref: 10 },
      ],
      edges: [{ from: "sys", to: "mod" }],
    };
    const result = await tool.execute(
      { figures: [STATE, hierarchy], output_name: "case-st", invention_name: "一种状态机" },
      makeContext(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("图1为本发明实施例提供的一种状态机的状态转移示意图"));
    assert.ok(text.includes("图2为本发明实施例提供的一种状态机的层级结构示意图"));

    const sidecar = parseFigureSidecar(readFileSync(join(cwd, ".sati", "figures", "case-st-figures.json"), "utf8"));
    assert.deepEqual(
      sidecar.figures.map(f => f.spec),
      [STATE, hierarchy],
      "符号形状与新图型应无损进入 sidecar（供下游零信息损耗重跑规则）",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_generate：符号形状带文字时工具输出报出 V18（不静默丢字）", async () => {
  const cwd = tempCwd();
  try {
    const tool = createPatentFigureGenerateTool();
    const noisy: FigureSpec = {
      ...STATE,
      nodes: STATE.nodes.map(node => (node.id === "s0" ? { ...node, label: "初态", ref: 99 } : node)),
    };
    const result = await tool.execute({ figures: [noisy], output_name: "case-v18" }, makeContext(cwd));
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.ok(text.includes("[WARN] V18"), text);
    assert.ok(text.includes("标记 99 亦随之不显示"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("入参枚举与 FigureKind/FigureNodeShape 同步（类型加了而 schema 漏加即失配）", () => {
  // Record<…, true> 由类型穷尽性强制：新增 kind/shape 时此处编译不过，提醒同步 schema。
  const kinds: Record<FigureKind, true> = {
    flowchart: true,
    block: true,
    state: true,
    hierarchy: true,
    chart: true,
  };
  const shapes: Record<FigureNodeShape, true> = {
    rect: true,
    round: true,
    diamond: true,
    ellipse: true,
    cylinder: true,
    parallelogram: true,
    circle: true,
    doublecircle: true,
  };
  const props = FIGURE_INPUT_SCHEMA_REF.properties as Record<string, { enum?: string[] }>;
  const itemProps = (props.nodes as unknown as { items: { properties: Record<string, { enum?: string[] }> } }).items
    .properties;
  assert.deepEqual(props.kind!.enum, Object.keys(kinds));
  assert.deepEqual(itemProps.shape!.enum, Object.keys(shapes));
});

test("入参枚举与 ChartMarker/ChartLineStyle 同步（曲线图取值同源守卫）", () => {
  const markers: Record<ChartMarker, true> = {
    none: true,
    circle: true,
    square: true,
    triangle: true,
    "filled-circle": true,
    "filled-square": true,
    "filled-triangle": true,
    cross: true,
    plus: true,
  };
  const lines: Record<ChartLineStyle, true> = { solid: true, dashed: true, dotted: true };
  const props = FIGURE_INPUT_SCHEMA_REF.properties as Record<
    string,
    { enum?: string[]; properties?: Record<string, unknown> }
  >;
  const series = (
    props.chart!.properties!.series as unknown as { items: { properties: Record<string, { enum?: string[] }> } }
  ).items.properties;
  assert.deepEqual(series.marker!.enum, Object.keys(markers));
  assert.deepEqual(series.line!.enum, Object.keys(lines));
  // 运行时收窄用的常量也必须与类型同源（schema 与常量各写一份必然漂移）。
  assert.deepEqual(CHART_MARKERS, Object.keys(markers));
  assert.deepEqual(CHART_LINE_STYLES, Object.keys(lines));
  assert.deepEqual(FIGURE_KINDS, props.kind!.enum);
});
