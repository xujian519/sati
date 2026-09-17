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
  CAD_JSON_BEGIN,
  CAD_JSON_END,
  CAD_MIN_FIT_SCALE,
  buildProjectionScript,
  buildScreenTransform,
  checkCadProjection,
  parseProjectionOutput,
  polylineLengthMm,
  projectStep,
  renderCadSvg,
  resolveFreecadCmd,
  type CadEdgeTable,
  type CadRunner,
} from "../../../src/patent/figuregen/cad/index.js";
import { PRINTABLE_HEIGHT_MM, PRINTABLE_WIDTH_MM } from "../../../src/patent/figuregen/page-contract.js";

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

test("脚本：含视图方向、定界标记与参考体探测；不产 SVG（交付契约归 Sati 渲染）", () => {
  const script = buildProjectionScript({ stepPath: "/tmp/x.step", view: "front" });
  assert.match(script, /DIRECTION = App\.Vector\(0, -1, 0\)/u, "front = -Y 方向");
  assert.match(script, /TechDraw\.project/u);
  assert.match(script, /_axis_image/u, "必须探测投影坐标系朝向");
  assert.ok(script.includes(CAD_JSON_BEGIN) && script.includes(CAD_JSON_END));
  assert.doesNotMatch(script, /svg/iu, "CAD 侧不得自行产 SVG");
  const iso = buildProjectionScript({ stepPath: "/tmp/x.step", view: "iso" });
  assert.match(iso, /App\.Vector\(1, -1, 1\)/u);
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

  assert.throws(() => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":1}\n`), /缺少定界标记/u);
  assert.throws(() => parseProjectionOutput(`${CAD_JSON_BEGIN}\n不是 JSON\n${CAD_JSON_END}`), /不是合法 JSON/u);
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":99,"view":"front","edges":[]}\n${CAD_JSON_END}`),
    /版本不支持/u,
  );
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":1,"view":"sideways","edges":[]}\n${CAD_JSON_END}`),
    /视图非法/u,
  );
  assert.throws(
    () =>
      parseProjectionOutput(
        `${CAD_JSON_BEGIN}\n{"version":1,"view":"front","edges":[{"kind":"visible","points":[[0,0]]}]}\n${CAD_JSON_END}`,
      ),
    /至少应有 2 个点/u,
  );
  assert.throws(
    () => parseProjectionOutput(`${CAD_JSON_BEGIN}\n{"version":1,"view":"front","edges":[]}\n${CAD_JSON_END}`),
    /缺少 axes/u,
  );
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
    x: [1, 0] as [number, number],
    y: [0, 0] as [number, number],
    z: [0, 1] as [number, number],
  };
  assert.equal(buildScreenTransform(degenerate, "top"), undefined, "top 视图要求屏幕上轴 = +Y，其像退化");
  assert.ok(buildScreenTransform(degenerate, "front"), "front 视图的右/上轴（+X/+Z）仍有像");
  assert.ok(buildScreenTransform(table.axes, "iso"), "iso 仍可定义（对角轴）");
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

  const us = renderCadSvg(table, { figureNo: 3, jurisdiction: "us" });
  assert.match(us.svg, />FIG\. 3</u);
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
