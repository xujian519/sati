/**
 * src/patent/figuregen/cad — CAD 投影链路测试（P2 阶段一）。
 *
 * 铁律：**单测不真跑 FreeCAD**（2.6GB 应用 + 平台差异）。走两头：
 * - `freecad.ts` 用注入的 runner + 手写 stdout（含横幅污染）；
 * - `render-cad.ts` / `checks.ts` 用**录制的真实边表**（`tests/fixtures/patent/cad/`，
 *   由本机 FreeCAD 1.1.3 对一只 40×30×10 带孔平板投影得到）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  CAD_HATCH_SPACING_MM,
  CAD_JSON_BEGIN,
  CAD_JSON_END,
  CAD_MIN_FIT_SCALE,
  CAD_REF_LEADER_MM,
  buildProjectionScript,
  buildScreenTransform,
  checkCadProjection,
  hatchPolylines,
  parseProjectionOutput,
  polylineLengthMm,
  projectModelPoints,
  projectStep,
  renderCadSvg,
  resolveFreecadCmd,
  type CadEdgeTable,
  type CadRefAnnotation,
  type CadRunner,
} from "../../../src/patent/figuregen/cad/index.js";
import { PRINTABLE_HEIGHT_MM, PRINTABLE_WIDTH_MM } from "../../../src/patent/figuregen/page-contract.js";
import { parseFigureSvg } from "../../../src/patent/figuregen/readback.js";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/patent/cad");

function loadTable(name: string): CadEdgeTable {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as CadEdgeTable;
}

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

test("能力探测：显式环境变量优先；缺失/非法路径 fail-loud；全部落空返回 undefined", () => {
  const exists = (path: string) => path === "/opt/fc/freecadcmd";
  assert.deepEqual(resolveFreecadCmd({ SATI_FREECAD_CMD: "/opt/fc/freecadcmd" }, { exists }), {
    cmd: "/opt/fc/freecadcmd",
    source: "SATI_FREECAD_CMD",
  });
  // 显式路径不存在 → 抛错（不静默回落到探测）
  assert.throws(() => resolveFreecadCmd({ SATI_FREECAD_CMD: "/nope/freecadcmd" }, { exists }), /不存在/u);
  // 无显式路径且探测落空 → undefined（调用方 fail-closed）
  assert.equal(resolveFreecadCmd({}, { exists: () => false }), undefined);
  // 探测命中常见安装位置
  const probed = resolveFreecadCmd({}, { exists: path => path.includes("FreeCAD.app") });
  assert.match(probed!.cmd, /FreeCAD\.app/u);
});

// ---------------------------------------------------------------------------
// 脚本生成 + stdout 解析（不真跑 FreeCAD）
// ---------------------------------------------------------------------------

test("脚本：含视图方向、定界标记、原点探测与剖切；不产 SVG（交付契约归 Sati 渲染）", () => {
  const script = buildProjectionScript({ stepPath: "/tmp/x.step", view: "front" });
  assert.match(script, /DIRECTION = App\.Vector\(0, -1, 0\)/u, "front = -Y 方向");
  assert.match(script, /TechDraw\.project/u);
  assert.match(script, /_probe/u, "必须探测投影坐标系朝向");
  assert.match(script, /'origin': _probe\(App\.Vector\(0, 0, 0\)\)/u, "必须探测原点像（仿射映射需要）");
  assert.ok(script.includes(CAD_JSON_BEGIN) && script.includes(CAD_JSON_END));
  assert.doesNotMatch(script, /svg/iu, "CAD 侧不得自行产 SVG");
  assert.match(script, /SECTION_OFFSET = None/u, "整视图不剖切");

  const iso = buildProjectionScript({ stepPath: "/tmp/x.step", view: "iso" });
  assert.match(iso, /App\.Vector\(1, -1, 1\)/u);

  // 剖切：脚本切半空间并输出剖切面轮廓（模型坐标）
  const section = buildProjectionScript({ stepPath: "/tmp/x.step", view: "top", sectionOffsetMm: 5 });
  assert.match(section, /SECTION_OFFSET = 5/u);
  assert.match(section, /shape\.common\(half\)/u, "剖切 = 与半空间求交");
  assert.match(section, /payload\['cutFaces'\] = cut_faces/u);
  assert.match(section, /axis = 2/u, "top 视图的剖切轴为 Z");
  // 轴测图无语义上的"剖切面"⇒ 脚本生成即 fail-loud
  assert.throws(() => buildProjectionScript({ stepPath: "/tmp/x.step", view: "iso", sectionOffsetMm: 5 }), /不能剖切/u);
});

test("解析：从含横幅/统计的 stdout 中按定界标记截取边表；标记缺失即报错", () => {
  const table = loadTable("plate-front.json");
  const stdout = [
    "FreeCAD 1.1.3, Libs: 1.1.3R20260725",
    "(C) 2001-2026 FreeCAD contributors",
    "** WorkSession : Sending all data",
    CAD_JSON_BEGIN,
    JSON.stringify(table),
    CAD_JSON_END,
    "曲线类型统计: {...} 总边数 11",
  ].join("\n");
  const parsed = parseProjectionOutput(stdout);
  assert.equal(parsed.view, "front");
  assert.equal(parsed.edges.length, table.edges.length);
  assert.deepEqual(parsed.axes, table.axes);
  assert.deepEqual(parsed.axes.origin, [0, 0], "投影平面过原点：原点像为 (0,0)");

  assert.throws(() => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":1}\n`), /缺少定界标记/u);
  assert.throws(() => parseProjectionOutput(`${CAD_JSON_BEGIN}\n不是 JSON\n${CAD_JSON_END}`), /不是合法 JSON/u);
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":1,"view":"front","edges":[]}\n${CAD_JSON_END}`),
    /版本不支持/u,
  );
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":2,"view":"sideways","edges":[]}\n${CAD_JSON_END}`),
    /视图非法/u,
  );
  assert.throws(
    () =>
      parseProjectionOutput(
        `${CAD_JSON_BEGIN}\n{"version":2,"view":"front","edges":[{"kind":"visible","points":[[0,0]]}]}\n${CAD_JSON_END}`,
      ),
    /至少应有 2 个点/u,
  );
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":2,"view":"front","edges":[]}\n${CAD_JSON_END}`),
    /缺少 axes/u,
  );
  // v1 边表（无原点像）不得被当作可用：仿射映射无法确定
  const v1 = { ...table, axes: { x: [0, 1], y: [0, 0], z: [-1, 0] } };
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n${JSON.stringify(v1)}\n${CAD_JSON_END}`),
    /axes\.origin/u,
  );
});

test("解析：剖切字段的结构校验（section 与 cutFaces 必须成对；轮廓点须为三维）", () => {
  const table = loadTable("plate-section-top.json");
  const wrap = (value: unknown) => `${CAD_JSON_BEGIN}\n${JSON.stringify(value)}\n${CAD_JSON_END}`;
  assert.equal(parseProjectionOutput(wrap(table)).cutFaces?.length, 1);

  const noCut = { ...table };
  delete (noCut as Record<string, unknown>).cutFaces;
  assert.throws(() => parseProjectionOutput(wrap(noCut)), /没有剖切面轮廓/u);

  const noSection = { ...table };
  delete (noSection as Record<string, unknown>).section;
  assert.throws(() => parseProjectionOutput(wrap(noSection)), /缺少 section 参数/u);

  const badExtent = { ...table, section: { offset_mm: 5 } };
  assert.throws(() => parseProjectionOutput(wrap(badExtent)), /model_extent_mm/u);

  const badLoop = { ...table, cutFaces: [{ loops: [[[0, 0]]] }] };
  assert.throws(() => parseProjectionOutput(wrap(badLoop)), /至少应有 3 个点/u);

  const badPoint = {
    ...table,
    cutFaces: [
      {
        loops: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        ],
      },
    ],
  };
  assert.throws(() => parseProjectionOutput(wrap(badPoint)), /应为 \[number, number, number\]/u);

  // 未闭合的环：剖面线会按"隐式闭合边"画到剖切面之外 ⇒ 解析期即拒绝
  const unclosed = {
    ...table,
    cutFaces: [
      {
        loops: [
          [
            [0, 0, 5],
            [10, 0, 5],
            [10, 10, 5],
          ],
        ],
      },
    ],
  };
  assert.throws(() => parseProjectionOutput(wrap(unclosed)), /未闭合/u);
});

test("运行：脚本经临时文件交付（freecadcmd 的 -c 是 console 模式，不是 python -c）", async () => {
  const calls: { args: readonly string[]; script?: string }[] = [];
  const runner: CadRunner = async (_cmd, args) => {
    const scriptPath = args[0];
    calls.push({ args, script: readFileSync(scriptPath, "utf8") });
    // 临时脚本在运行期存在 → 读取内容可校验；返回录制边表
    return {
      stdout: `${CAD_JSON_BEGIN}\n${JSON.stringify(loadTable("plate-front.json"))}\n${CAD_JSON_END}`,
      stderr: "",
      code: 0,
    };
  };
  const table = await projectStep({ cmd: "/fake/freecadcmd", stepPath: "/tmp/x.step", view: "front", runner });
  assert.equal(table.edges.length, 11);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.length, 1, "只传脚本路径（无 -c 之类的伪代码开关）");
  assert.match(calls[0].script ?? "", /STEP_PATH = "\/tmp\/x\.step"/u);
});

test("运行：非零退出码 → fail-closed 并带出 stderr 尾部", async () => {
  const runner: CadRunner = async () => ({
    stdout: "banner",
    stderr: "Traceback\nSystemExit: STEP 读取失败或几何为空",
    code: 1,
  });
  await assert.rejects(
    projectStep({ cmd: "/fake/freecadcmd", stepPath: "/tmp/missing.step", view: "front", runner }),
    /freecadcmd 投影失败（退出码 1）.*STEP 读取失败/u,
  );
});

test("运行：边数超上限 → fail-closed（大装配不出图）", async () => {
  const table = loadTable("plate-front.json");
  const many: CadEdgeTable = {
    ...table,
    edges: Array.from({ length: 20_001 }, () => table.edges[0]),
  };
  const runner: CadRunner = async () => ({
    stdout: `${CAD_JSON_BEGIN}\n${JSON.stringify(many)}\n${CAD_JSON_END}`,
    stderr: "",
    code: 0,
  });
  await assert.rejects(
    projectStep({ cmd: "/fake/freecadcmd", stepPath: "/tmp/x.step", view: "front", runner }),
    /超过上限/u,
  );
});

// ---------------------------------------------------------------------------
// 朝向对齐 + 渲染（真实录制的边表）
// ---------------------------------------------------------------------------

test("朝向对齐：front 视图把模型 Z 轴对齐为图上竖直（40mm 宽 × 10mm 高）", () => {
  const table = loadTable("plate-front.json");
  const transform = buildScreenTransform(table.axes, "front");
  assert.ok(transform, "front 视图的屏幕轴应可定义");
  const points = table.edges.flatMap(edge => edge.points.map(([u, v]) => [transform!.x(u, v), transform!.y(u, v)]));
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  // 平板 40(X) × 30(Y) × 10(Z)：front 视图应为 40 宽 × 10 高（同时排除"旋转 90°"）
  assert.ok(Math.abs(width - 40) < 0.01, `宽度应为 40mm，实际 ${width}`);
  assert.ok(Math.abs(height - 10) < 0.01, `高度应为 10mm，实际 ${height}`);
  // 不镜像：切除区（圆柱在 X 0..4）的竖直轮廓线应落在屏幕 x≈4，而不是 x≈36
  const verticalXs = table.edges
    .filter(edge => edge.kind === "visible" && edge.curve === "Line")
    .map(edge => edge.points.map(([u, v]) => transform!.x(u, v)))
    .filter(column => Math.max(...column) - Math.min(...column) < 1e-6)
    .map(column => column[0]);
  assert.ok(
    verticalXs.some(x => Math.abs(x - 4) < 0.01),
    `应有位于模型 X=4 的竖直轮廓线（实际 ${verticalXs.join(", ")}）`,
  );
  assert.ok(!verticalXs.some(x => Math.abs(x - 36) < 0.01), "不得镜像（镜像时轮廓线会落在 X=36）");
  // 模型上方映射为更小的屏幕 y（SVG y 向下）：Z=10 的顶面 y=-10 < Z=0 的底面 y=0
  assert.ok(Math.max(...ys) - Math.min(...ys) === 10);
});

test("朝向对齐：屏幕轴在投影面退化 → 返回 undefined（调用方 fail-loud）", () => {
  const table = loadTable("plate-front.json");
  // 轴像退化：模型 +Y 在投影面上是一个点（该轴正对视线）
  const degenerate = {
    origin: [0, 0] as [number, number],
    x: [1, 0] as [number, number],
    y: [0, 0] as [number, number],
    z: [0, 1] as [number, number],
  };
  assert.equal(buildScreenTransform(degenerate, "top"), undefined, "top 视图要求屏幕上轴 = +Y，其像退化");
  assert.ok(buildScreenTransform(degenerate, "front"), "front 视图的右/上轴（+X/+Z）仍有像");
  assert.ok(buildScreenTransform(table.axes, "iso"), "iso 仍可定义（对角轴）");
});

test("模型→投影仿射映射：轴像减原点像得投影矩阵列；原点映到原点像", () => {
  const table = loadTable("plate-front.json");
  const [origin] = projectModelPoints(table.axes, [[0, 0, 0]]);
  assert.deepEqual(origin, table.axes.origin);
  const [unitX, unitY, unitZ] = projectModelPoints(table.axes, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  // front 视图：u = −Z、v = X（实测 TechDraw 的坐标系即如此）
  assert.ok(Math.abs(unitX![1] - 1) < 1e-6, "模型 +X 应映射到 v=+1");
  assert.ok(Math.abs(unitY![1]) < 1e-6, "模型 +Y 正对视线 ⇒ 像退化为一点（v 分量 0）");
  assert.ok(Math.abs(unitZ![0] + 1) < 1e-6, "模型 +Z 应映射到 u=−1");
  // 平移分量必须被减掉：整体平移模型不改变投影的相对形状
  const shifted = { ...table.axes, origin: [3, 4] as [number, number] };
  const [p] = projectModelPoints(shifted, [[0, 0, 0]]);
  assert.deepEqual(p, [3, 4], "原点像即平移分量");
});

test("渲染：front 视图出黑白 SVG（仅 #000000/#FFFFFF）、图号标注、A4 可印区内", () => {
  const table = loadTable("plate-front.json");
  const render = renderCadSvg(table, { figureNo: 1 });
  const colors = render.svg.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
  for (const color of colors) {
    assert.ok(["#000000", "#FFFFFF"].includes(color.toUpperCase()), `非黑白颜色 ${color}`);
  }
  assert.match(render.svg, />图1</u, "应有图号标注");
  assert.ok(render.widthMm <= PRINTABLE_WIDTH_MM && render.heightMm <= PRINTABLE_HEIGHT_MM);
  assert.equal(render.hiddenEdges > 0, true, "平板有隐藏边");
  assert.equal((render.svg.match(/<polyline/gu) ?? []).length, render.visibleEdges, "默认不画隐藏线");
  assert.doesNotMatch(render.svg, /stroke-dasharray/u, "默认无虚线");

  const withHidden = renderCadSvg(table, { figureNo: 2, hiddenLines: true });
  assert.equal((withHidden.svg.match(/<polyline/gu) ?? []).length, withHidden.visibleEdges + withHidden.hiddenEdges);
  assert.match(withHidden.svg, /stroke-dasharray/u, "开启隐藏线时虚线绘制");

  const usMulti = renderCadSvg(table, { figureNo: 3, jurisdiction: "us", figureCount: 2 });
  assert.match(usMulti.svg, />FIG\. 3</u);
  // 单幅在 us/pct 不得编号（37 CFR 1.84(u)(1)、PCT 指南 IP 5.141）
  const usSingle = renderCadSvg(table, { figureNo: 3, jurisdiction: "us" });
  assert.doesNotMatch(usSingle.svg, /FIG\./u);
});

test("渲染：大几何按可印区适配缩放，纸面尺寸不超框", () => {
  const table = loadTable("plate-front.json");
  // 把几何放大 20 倍（≈800×200mm）→ 必须缩放
  const scaled: CadEdgeTable = {
    ...table,
    edges: table.edges.map(edge => ({
      ...edge,
      points: edge.points.map(([u, v]) => [u * 20, v * 20] as [number, number]),
    })),
  };
  const render = renderCadSvg(scaled, { figureNo: 1 });
  assert.ok(render.scale < 1, "应触发缩放");
  assert.ok(render.widthMm <= PRINTABLE_WIDTH_MM + 1e-6);
  assert.ok(render.heightMm <= PRINTABLE_HEIGHT_MM + 1e-6);
});

test("渲染：无可绘制边 → throw（不产出空图）", () => {
  const table = loadTable("plate-front.json");
  const hiddenOnly: CadEdgeTable = { ...table, edges: table.edges.filter(edge => edge.kind === "hidden") };
  assert.throws(() => renderCadSvg(hiddenOnly, { figureNo: 1 }), /没有可绘制的可见边/u);
});

test("几何级检查：无可见边 → C1 fail；退化短边 → C2 warn；缩放过低 → C3 warn；隐藏线 → C4 info", () => {
  const table = loadTable("plate-front.json");
  const render = renderCadSvg(table, { figureNo: 1 });
  const clean = checkCadProjection({ table, render, hiddenLines: false });
  assert.deepEqual(
    clean.filter(finding => finding.severity === "fail"),
    [],
  );
  assert.ok(clean.some(finding => finding.rule === "C1" && finding.severity === "info"));

  const hiddenOnly: CadEdgeTable = { ...table, edges: table.edges.filter(edge => edge.kind === "hidden") };
  const empty = checkCadProjection({ table: hiddenOnly, render, hiddenLines: false });
  assert.ok(empty.some(finding => finding.rule === "C1" && finding.severity === "fail"));

  const tiny: CadEdgeTable = {
    ...table,
    edges: [
      {
        kind: "visible",
        curve: "Line",
        closed: false,
        points: [
          [0, 0],
          [0.05, 0],
        ],
      },
    ],
  };
  const degenerate = checkCadProjection({ table: tiny, render, hiddenLines: false });
  assert.ok(degenerate.some(finding => finding.rule === "C2" && finding.severity === "warn"));
  assert.equal(
    polylineLengthMm([
      [0, 0],
      [0.05, 0],
    ]),
    0.05,
  );

  const small = checkCadProjection({ table, render: { ...render, scale: CAD_MIN_FIT_SCALE - 0.1 }, hiddenLines: true });
  assert.ok(small.some(finding => finding.rule === "C3" && finding.severity === "warn"));
  assert.ok(small.some(finding => finding.rule === "C4" && finding.severity === "info"));
});

test("iso 视图同样可渲染（真实录制边表）", () => {
  const table = loadTable("plate-iso.json");
  const render = renderCadSvg(table, { figureNo: 1 });
  assert.ok(render.visibleEdges > 0);
  assert.match(render.svg, /<polyline/u);
});

// ---------------------------------------------------------------------------
// 剖面线（45° 扫描线填充，纸面毫米间距）
// ---------------------------------------------------------------------------

test("剖面线：45° 等间距、方格内成段、孔洞留空（奇偶规则）", () => {
  const square: [number, number][][] = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ];
  const segments = hatchPolylines(square, CAD_HATCH_SPACING_MM);
  assert.ok(segments.length > 0, "方格内应有剖面线");
  for (const [from, to] of segments) {
    // 45°：Δx 与 Δy 绝对值相等
    assert.ok(Math.abs(Math.abs(to[0] - from[0]) - Math.abs(to[1] - from[1])) < 1e-9, "剖面线须为 45°");
  }
  // 相邻平行线的垂直距离 = 间距（在旋转坐标系里即行距）
  const offsets = segments.map(([from]) => (from[1] - from[0]) / Math.SQRT2).sort((a, b) => a - b);
  const gaps = offsets.slice(1).map((value, index) => value - offsets[index]!);
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - CAD_HATCH_SPACING_MM) < 1e-6, `行距应为 ${CAD_HATCH_SPACING_MM}mm，实际 ${gap}`);
  }
  // 确定性：同输入两次同输出
  assert.deepEqual(hatchPolylines(square, CAD_HATCH_SPACING_MM), segments);

  // 孔洞：内环覆盖的区域内不得有剖面线（奇偶规则）
  const withHole = hatchPolylines(
    [
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      [
        [5, 5],
        [15, 5],
        [15, 15],
        [5, 15],
      ],
    ],
    CAD_HATCH_SPACING_MM,
  );
  const insideHole = withHole.filter(([from, to]) => {
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    return mid[0]! > 5.01 && mid[0]! < 14.99 && mid[1]! > 5.01 && mid[1]! < 14.99;
  });
  assert.deepEqual(insideHole, [], "孔洞内不得有剖面线");
  assert.ok(
    withHole.length >
      hatchPolylines(
        [
          [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
          ],
        ],
        CAD_HATCH_SPACING_MM,
      ).length,
    "带孔的面剖面线更多（孔洞把长线切成两段）",
  );
  assert.deepEqual(hatchPolylines(square, 0), [], "间距非正 ⇒ 不产生剖面线");
});

// ---------------------------------------------------------------------------
// 剖视图（录制的真实边表）
// ---------------------------------------------------------------------------

test("剖视图：剖切面轮廓与剖面线（真实录制边表，剖切面 = 平板轮廓减去半圆槽）", () => {
  const table = loadTable("plate-section-top.json");
  assert.ok(table.section, "剖视图边表须带剖切参数");
  assert.equal(table.section!.offset_mm, 5);
  assert.deepEqual(table.section!.model_extent_mm, [0, 10], "模型沿视线方向（Z）范围为 0–10mm");
  assert.equal(table.cutFaces?.length, 1);
  const loop = table.cutFaces![0]!.loops[0]!;
  const xs = loop.map(point => point[0]);
  const ys = loop.map(point => point[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 40], "剖切面覆盖平板全宽");
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 30], "剖切面覆盖平板全深");
  assert.ok(
    loop.every(point => point[2] === 5),
    "剖切面轮廓须落在剖切平面上（Z=5）",
  );

  const render = renderCadSvg(table, { figureNo: 1 });
  assert.equal(render.cutFaces, 1);
  assert.ok(render.hatchSegments > 0, "剖切面须画出剖面线");
  assert.match(render.svg, /<path d="M[^"]*" fill="none" stroke="#000000"/u, "剖面线为黑色路径");
  // 剖面线（细实线）不得粗于轮廓线
  assert.ok(render.hatchSegments < 40, `剖面线段数应有限（实际 ${render.hatchSegments}）`);
});

test("剖视图：剖切面落在模型范围之外 ⇒ C5 fail（名义剖视图退化为整视图）", () => {
  const table = loadTable("plate-section-top.json");
  const offRange: CadEdgeTable = {
    ...table,
    section: { offset_mm: 30, model_extent_mm: [0, 10] },
    cutFaces: [],
  };
  const findings = checkCadProjection({ table: offRange, hiddenLines: false });
  const c5 = findings.find(finding => finding.rule === "C5");
  assert.equal(c5?.severity, "fail");
  assert.match(c5!.message, /未切开任何材料/u);
  assert.ok(
    c5!.evidence?.some(item => item.includes("30")),
    "证据须给出剖切偏移与模型范围",
  );

  // 有效的剖切：info 级如实报告剖切面数
  const ok = checkCadProjection({ table, hiddenLines: false });
  assert.ok(ok.some(finding => finding.rule === "C5" && finding.severity === "info"));
  assert.deepEqual(
    ok.filter(finding => finding.severity === "fail"),
    [],
  );
});

test("剖视图：剖切面过小画不出剖面线 ⇒ C6 warn（如实降级而非假装有剖面线）", () => {
  const table = loadTable("plate-section-top.json");
  const render = renderCadSvg(table, { figureNo: 1 });
  const findings = checkCadProjection({ table, render: { ...render, hatchSegments: 0 }, hiddenLines: false });
  const c6 = findings.find(finding => finding.rule === "C6");
  assert.equal(c6?.severity, "warn");
  assert.match(c6!.message, /剖面线无法表达/u);
  // 有剖面线时不报 C6
  assert.ok(!checkCadProjection({ table, render, hiddenLines: false }).some(finding => finding.rule === "C6"));
});

// ---------------------------------------------------------------------------
// 附图标记标注
// ---------------------------------------------------------------------------

test("标注：锚点投影 + 引线 + data-ref（回读契约与内置渲染器同构）", () => {
  const table = loadTable("plate-front.json");
  // 平板 40(X) × 30(Y) × 10(Z)：front 视图里 v=X、u=−Z ⇒ 用模型坐标锚点
  const annotations: CadRefAnnotation[] = [
    { ref: 10, atMm: [40, 15, 10] },
    { ref: 20, atMm: [20, 15, 0] },
  ];
  const render = renderCadSvg(table, { figureNo: 1, annotations });
  assert.equal(render.labels.length, 2);
  assert.match(render.svg, /<g id="n-ref-10" data-ref="10">/u);
  assert.match(render.svg, /<g id="n-ref-20" data-ref="20">/u);
  assert.match(render.svg, /<text x="[^"]*" y="[^"]*" font-size="3" text-anchor="middle"/u);
  assert.equal((render.svg.match(/<polyline/gu) ?? []).length, render.visibleEdges + 2, "每个标记一条引线");

  // 锚点必须落在图内（模型坐标 → 图面的落位）
  for (const label of render.labels) {
    assert.ok(
      label.anchorMm[0] >= render.geometryBoundsMm.left - 1e-6 &&
        label.anchorMm[0] <= render.geometryBoundsMm.right + 1e-6 &&
        label.anchorMm[1] >= render.geometryBoundsMm.top - 1e-6 &&
        label.anchorMm[1] <= render.geometryBoundsMm.bottom + 1e-6,
      `标记 ${label.ref} 的锚点须落在图内：${JSON.stringify(label.anchorMm)}`,
    );
  }
  // 缺省引线方向：向图外（ref 10 锚在右端 ⇒ 标号应落在锚点右侧）
  const right = render.labels.find(label => label.ref === 10)!;
  assert.ok(right.labelMm[0] > right.anchorMm[0] + CAD_REF_LEADER_MM * 0.5, "标号应向图外引");
  // 图幅含标注后仍不超可印区（构造保证）
  assert.ok(render.widthMm <= PRINTABLE_WIDTH_MM && render.heightMm <= PRINTABLE_HEIGHT_MM);

  // 回读：CAD 图的标记可被 patent_figure_check 的 svg_paths 通道复核
  const parsed = parseFigureSvg(render.svg);
  assert.deepEqual(
    parsed.nodes.map(node => node.ref),
    [10, 20],
  );
  assert.equal(parsed.figureNo, 1);

  // 显式图面偏移：标号落在指定位置
  const pinned = renderCadSvg(table, {
    figureNo: 1,
    annotations: [{ ref: 30, atMm: [20, 15, 5], labelOffsetMm: [-20, -8] }],
  });
  const label = pinned.labels[0]!;
  assert.ok(Math.abs(label.labelMm[0] - (label.anchorMm[0] - 20)) < 1e-6);
  assert.ok(Math.abs(label.labelMm[1] - (label.anchorMm[1] - 8)) < 1e-6);
  assert.deepEqual(
    parseFigureSvg(pinned.svg).nodes.map(node => node.ref),
    [30],
  );
});

test("标注：无标注时图幅与旧行为逐位一致（预留带只在有标注时占用）", () => {
  const table = loadTable("plate-front.json");
  const plain = renderCadSvg(table, { figureNo: 1 });
  const annotated = renderCadSvg(table, { figureNo: 1, annotations: [] });
  assert.deepEqual(annotated, plain);
  assert.equal(plain.svg.includes("n-ref-"), false, "无标注不得出现标号分组");
  assert.ok(plain.widthMm <= PRINTABLE_WIDTH_MM && plain.heightMm <= PRINTABLE_HEIGHT_MM);
});

test("标注：标号重叠 ⇒ C7 warn；锚点落在图外 ⇒ C8 warn；标号越出图幅 ⇒ C9 fail", () => {
  const table = loadTable("plate-front.json");

  // C7：两个锚点几乎同位置、引线方向一致 ⇒ 标号重叠
  const overlapping = renderCadSvg(table, {
    figureNo: 1,
    annotations: [
      { ref: 10, atMm: [40, 15, 10] },
      { ref: 11, atMm: [40, 15, 10.001] },
    ],
  });
  const c7 = checkCadProjection({ table, render: overlapping, hiddenLines: false }).find(
    finding => finding.rule === "C7",
  );
  assert.equal(c7?.severity, "warn");
  assert.match(c7!.message, /重叠/u);

  // C8：锚点写在投影几何之外（该处图面上没有几何）
  const outside = renderCadSvg(table, { figureNo: 1, annotations: [{ ref: 12, atMm: [400, 15, 10] }] });
  const c8 = checkCadProjection({ table, render: outside, hiddenLines: false }).find(finding => finding.rule === "C8");
  assert.equal(c8?.severity, "warn");
  assert.match(c8!.message, /锚点落在投影几何范围之外/u);
  // 正常锚点不报 C8
  const inside = renderCadSvg(table, { figureNo: 1, annotations: [{ ref: 13, atMm: [40, 15, 10] }] });
  assert.ok(!checkCadProjection({ table, render: inside, hiddenLines: false }).some(f => f.rule === "C8"));

  // C9：显式偏移把标号推出图幅（会被画幅裁掉）
  const pushedOut = renderCadSvg(table, {
    figureNo: 1,
    annotations: [{ ref: 14, atMm: [40, 15, 10], labelOffsetMm: [45, 0] }],
  });
  const c9 = checkCadProjection({ table, render: pushedOut, hiddenLines: false }).find(
    finding => finding.rule === "C9",
  );
  assert.equal(c9?.severity, "fail");
  assert.match(c9!.message, /超出图幅/u);
});

test("剖视图：剖切面轮廓是闭合回路（乱序边序必须被拼成走向，否则剖面线会画到面外）", () => {
  const table = loadTable("plate-section-top.json");
  const loop = table.cutFaces![0]!.loops[0]!;
  const first = loop[0]!;
  const last = loop[loop.length - 1]!;
  assert.ok(
    Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) < 1e-6,
    "环必须回到起点（闭合回路）",
  );
  // 回路长度应约等于轮廓周长：40×30 矩形减缺口弦加半圆弧 ≈ 142.8mm。
  // 乱序拼接会留下跨图的假闭合边（实测出现 222mm 的自交回路）。
  let perimeter = 0;
  let longestStep = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    perimeter += step;
    longestStep = Math.max(longestStep, step);
  }
  assert.ok(perimeter > 140 && perimeter < 146, `回路长度应≈142.8mm，实际 ${perimeter.toFixed(2)}`);
  assert.ok(longestStep < 3, `相邻点步长应远小于图幅（离散化 0.2mm），实际 ${longestStep.toFixed(2)}`);
});

test("剖视图：剖面线全部落在剖切面内（越出材料即为画错）", () => {
  const table = loadTable("plate-section-top.json");
  const render = renderCadSvg(table, { figureNo: 1 });
  const path = render.svg.match(/<path d="([^"]*)"[^>]*stroke-width="0.2"/u)?.[1];
  assert.ok(path, "剖面线须为独立的 0.2mm 细实线路径");
  const segments = [...path.matchAll(/M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)/gu)].map(match => [
    [Number(match[1]), Number(match[2])] as [number, number],
    [Number(match[3]), Number(match[4])] as [number, number],
  ]);
  assert.equal(segments.length, render.hatchSegments);

  // 把剖切面轮廓映射到纸面（与渲染器同源：模型 → (u,v) → 屏幕 → 缩放平移）
  const transform = buildScreenTransform(table.axes, "top")!;
  const local = table.cutFaces![0]!.loops[0]!.map(point => {
    const [u, v] = projectModelPoints(table.axes, [point])[0]!;
    return [transform.x(u, v), transform.y(u, v)] as [number, number];
  });
  const localMinX = Math.min(...local.map(point => point[0]));
  const localMinY = Math.min(...local.map(point => point[1]));
  const scale =
    (render.geometryBoundsMm.right - render.geometryBoundsMm.left) / (Math.max(...local.map(p => p[0])) - localMinX);
  const polygon = local.map(
    ([x, y]) =>
      [
        render.geometryBoundsMm.left + (x - localMinX) * scale,
        render.geometryBoundsMm.top + (y - localMinY) * scale,
      ] as [number, number],
  );
  const inside = (point: [number, number]): boolean => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i]!;
      const b = polygon[j]!;
      if (
        a[1] > point[1] !== b[1] > point[1] &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
      ) {
        hit = !hit;
      }
    }
    return hit;
  };
  const outside = segments.filter(([from, to]) => !inside([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]));
  assert.deepEqual(outside, [], `剖面线中点须全在剖切面内，越界 ${outside.length} 段`);
  // 缺口（半圆）区域内不得有剖面线 —— 该处不是材料
  const inNotch = segments.filter(([from, to]) => {
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    return (
      mid[0]! > render.geometryBoundsMm.left - 1 &&
      mid[0]! < render.geometryBoundsMm.left + 2 &&
      mid[1]! < render.geometryBoundsMm.top + 1
    );
  });
  assert.deepEqual(inNotch, [], "缺口处不是材料，不得有剖面线");
});
