/**
 * src/patent/figuregen/cad — 批次 C（CAD 结构线稿深度）测试。
 *
 * 覆盖三项能力：
 * - **C-1** 每零件几何事实 + 件号锚点自动选取与核对（`anchors.ts` + C14/C15）；
 * - **C-2** 多视图一次产出 + manifest（`views.ts` + `structure-manifest.ts` + v3 载荷）；
 * - **C-3** 剖面线方向交替（GB/T 4457.5，相邻零件方向相反）。
 *
 * 铁律（AGENTS.md 第 11 条）：依赖 FreeCAD 的用例在缺 FreeCAD 的环境自动 skip——
 * **跳过表示「无信号」，不是「通过」**：CI 未装 FreeCAD ⇒ 这条链路在 CI 上没有信号，
 * 必须靠本地真机跑（见 `docs/notes/implemented/2026-11-12-figure-dsh-alignment-batch-c.md`
 * 的探针记录）来补。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CAD_ANCHOR_OUTSET_MM,
  CAD_AUTO_ANCHORS_ENV,
  CAD_JSON_BEGIN,
  CAD_JSON_END,
  CAD_VIEWS_ENV,
  anchorOutsetMm,
  bindCallouts,
  buildCadStructureManifest,
  buildProjectionScript,
  checkCadProjection,
  hatchPolylines,
  orderCutFacesByProximity,
  parseProjectionPayload,
  projectCadViews,
  projectViews,
  renderCadSvg,
  resolveCadViewPlan,
  resolveFreecadCmd,
  type CadAnchorCheck,
  type CadEdgeTable,
  type CadPartFact,
  type CadRunner,
} from "../../../src/patent/figuregen/cad/index.js";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/patent/cad");

function loadTable(name: string): CadEdgeTable {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as CadEdgeTable;
}

/** 投影产物在 stdout 里的定界包裹（freecadcmd 会混进横幅与统计 ⇒ 必须按标记截取）。 */
function wrap(payload: unknown): string {
  return `${CAD_JSON_BEGIN}\n${JSON.stringify(payload)}\n${CAD_JSON_END}`;
}

// ---------------------------------------------------------------------------
// C-2：部署级视图计划（env）
// ---------------------------------------------------------------------------

test("C-2 视图计划：env 未设置 ⇒ 单视图（维持现状）；env 设置 ⇒ 主视图优先 + 去重保序", () => {
  const single = resolveCadViewPlan({}, "front");
  assert.deepEqual(single.views, ["front"]);
  assert.equal(single.autoAnchors, false);
  assert.match(single.source, /单视图/u);

  const multi = resolveCadViewPlan({ [CAD_VIEWS_ENV]: "top,right" }, "front");
  assert.deepEqual(multi.views, ["front", "top", "right"], "view 入参仍是主视图（优先）");
  assert.match(multi.source, /SATI_CAD_VIEWS/u);

  const dup = resolveCadViewPlan({ [CAD_VIEWS_ENV]: "front,top,front" }, "front");
  assert.deepEqual(dup.views, ["front", "top"], "同名视图去重");
});

test("C-2 视图计划：非法视图名 / 非法布尔取值 ⇒ fail-loud（部署配置写错必须当场报出）", () => {
  assert.throws(() => resolveCadViewPlan({ [CAD_VIEWS_ENV]: "sideways" }, "front"), /非法视图名/u);
  assert.throws(() => resolveCadViewPlan({ [CAD_AUTO_ANCHORS_ENV]: "maybe" }, "front"), /取值非法/u);
  assert.equal(resolveCadViewPlan({ [CAD_AUTO_ANCHORS_ENV]: "1" }, "front").autoAnchors, true);
  assert.equal(resolveCadViewPlan({ [CAD_AUTO_ANCHORS_ENV]: "off" }, "front").autoAnchors, false);
});

// ---------------------------------------------------------------------------
// C-2：v3 载荷（多视图 + 零件事实 + 锚点归属）与 v2 兼容
// ---------------------------------------------------------------------------

const V3_PAYLOAD = {
  version: 3,
  views: [
    {
      view: "front",
      units: "mm",
      axes: { origin: [0, 0], x: [0, 1], y: [0, 0], z: [-1, 0] },
      edges: [
        {
          kind: "visible",
          curve: "Line",
          closed: false,
          points: [
            [0, 0],
            [10, 0],
          ],
        },
      ],
      curveKinds: { Line: 1 },
    },
    {
      view: "top",
      units: "mm",
      axes: { origin: [0, 0], x: [1, 0], y: [0, 1], z: [0, 0] },
      edges: [
        {
          kind: "visible",
          curve: "Line",
          closed: false,
          points: [
            [0, 0],
            [10, 0],
          ],
        },
      ],
      curveKinds: { Line: 1 },
    },
  ],
  parts: [
    {
      index: 0,
      bbox: { min: [0, 0, 0], max: [40, 30, 10] },
      centroid: [20, 15, 5],
      area: 3800,
      volume: 12000,
      views: {
        front: {
          projectedBBox: { min: [-10, 0], max: [0, 40] },
          suggestedAnchor: [0, 0, 0],
          suggestedAnchorProjected: [0, 0],
        },
      },
    },
  ],
  anchors: [
    {
      point: [5, 5, 0],
      ownerPart: 0,
      onPart: true,
      surfaceDistanceMm: 0,
      bboxDistanceMm: 0,
      nearestPart: 0,
      nearestSurfaceDistanceMm: 0,
    },
  ],
};

test("C-2 载荷：v3 解析出多视图 + 零件事实 + 锚点归属", () => {
  const payload = parseProjectionPayload(wrap(V3_PAYLOAD));
  assert.equal(payload.version, 3);
  assert.deepEqual(
    payload.views.map(view => view.view),
    ["front", "top"],
  );
  assert.equal(payload.parts.length, 1);
  assert.equal(payload.parts[0]!.volume, 12000);
  assert.equal(payload.parts[0]!.views.front?.suggestedAnchorProjected?.[0], 0);
  assert.equal(payload.anchors[0]!.ownerPart, 0);
  assert.equal(payload.anchors[0]!.onPart, true);
});

test("C-2 载荷：v2 历史单视图载荷仍可解析（零件与锚点为空，不编造）", () => {
  const legacy = loadTable("plate-front.json");
  const payload = parseProjectionPayload(wrap(legacy));
  assert.equal(payload.version, 2);
  assert.equal(payload.views.length, 1);
  assert.equal(payload.views[0]!.view, "front");
  assert.deepEqual(payload.parts, []);
  assert.deepEqual(payload.anchors, []);
});

test("C-2 载荷：零件事实结构非法 ⇒ 抛错（不静默丢字段）", () => {
  const broken = { ...V3_PAYLOAD, parts: [{ ...V3_PAYLOAD.parts[0], area: "big" }] };
  assert.throws(() => parseProjectionPayload(wrap(broken)), /area 应为数字/u);
  const brokenAnchor = { ...V3_PAYLOAD, anchors: [{ ...V3_PAYLOAD.anchors[0], ownerPart: -1 }] };
  assert.throws(() => parseProjectionPayload(wrap(brokenAnchor)), /ownerPart/u);
});

test("C-2 运行：多视图只跑一次 FreeCAD（同一模型投影多视图）", async () => {
  const calls: { args: readonly string[]; script: string }[] = [];
  const runner: CadRunner = async (_cmd, args) => {
    // 临时脚本在运行期存在 ⇒ 运行期读取内容（运行结束后目录会被清理）
    calls.push({ args, script: readFileSync(args[0]!, "utf8") });
    return { stdout: wrap(V3_PAYLOAD), stderr: "", code: 0 };
  };
  const payload = await projectViews({
    cmd: "/fake/freecadcmd",
    stepPath: "/tmp/x.step",
    views: ["front", "top"],
    runner,
  });
  assert.equal(calls.length, 1, "多视图不得每视图跑一个进程");
  assert.equal(payload.views.length, 2);
  assert.match(calls[0]!.script, /for VIEW, DIRECTION in VIEW_LIST:/u);
});

// ---------------------------------------------------------------------------
// C-1：件号 ↔ 零件归属与锚点自动选取
// ---------------------------------------------------------------------------

const PART_A: CadPartFact = {
  index: 0,
  bbox: { min: [0, 0, 0], max: [40, 30, 10] },
  centroid: [20, 15, 5],
  area: 3800,
  volume: 12000,
  views: {
    front: {
      projectedBBox: { min: [-10, 0], max: [0, 40] },
      suggestedAnchor: [0, 0, 0],
      suggestedAnchorProjected: [0, 0],
    },
  },
};

const PART_B: CadPartFact = {
  index: 1,
  bbox: { min: [50, 0, 0], max: [90, 30, 10] },
  centroid: [70, 15, 5],
  area: 3800,
  volume: 12000,
  views: {
    front: {
      projectedBBox: { min: [-10, 50], max: [0, 90] },
      suggestedAnchor: [50, 0, 0],
      suggestedAnchorProjected: [0, 50],
    },
  },
};

const CHECK_ON_A: CadAnchorCheck = {
  point: [5, 5, 0],
  ownerPart: 0,
  onPart: true,
  surfaceDistanceMm: 0,
  bboxDistanceMm: 0,
};

test("C-1 归属：显式锚点优先；未被显式覆盖的零件按**零件顺序**自动补件号", () => {
  const binding = bindCallouts({
    explicit: [{ ref: 10, atMm: [5, 5, 0] }],
    checks: [CHECK_ON_A],
    parts: [PART_A, PART_B],
    view: "front",
    autoAnchors: true,
  });
  assert.deepEqual(
    binding.bindings.map(item => [item.ref, item.partIndex, item.source]),
    [
      [10, 0, "explicit"],
      [1, 1, "auto"],
    ],
  );
  assert.deepEqual(binding.unboundRefs, []);
  // 自动件号的锚点取自零件的建议锚点，并外推到零件投影包围盒之外
  assert.deepEqual(binding.annotations[1]!.atMm, [50, 0, 0]);
  assert.notDeepEqual(binding.annotations[1]!.anchorOffsetMm, [0, 0]);
});

test("C-1 归属：自动件号取未被占用的最小正整数（确定性、可复现）", () => {
  const binding = bindCallouts({
    explicit: [
      { ref: 1, atMm: [5, 5, 0] },
      { ref: 3, atMm: [55, 5, 0] },
    ],
    checks: [CHECK_ON_A, { ...CHECK_ON_A, point: [55, 5, 0], ownerPart: 1 }],
    parts: [PART_A, PART_B],
    view: "front",
    autoAnchors: true,
  });
  assert.deepEqual(
    binding.bindings.map(item => [item.ref, item.partIndex]),
    [
      [1, 0],
      [3, 1],
    ],
  );
});

test("C-1 归属：锚点不落在任何零件上 ⇒ 记入 unbound（C14 的输入），不静默画引线", () => {
  const binding = bindCallouts({
    explicit: [{ ref: 7, atMm: [500, 500, 500] }],
    checks: [{ point: [500, 500, 500], ownerPart: null, onPart: false, nearestPart: 0, nearestSurfaceDistanceMm: 12 }],
    parts: [PART_A, PART_B],
    view: "front",
    autoAnchors: false,
  });
  assert.deepEqual(binding.unboundRefs, [7]);
  assert.equal(binding.bindings[0]!.partIndex, null);
});

test("C-1 口径：模型没有 solid ⇒ 零件口径不适用（如实声明，不判通过也不误报 C14）", () => {
  const binding = bindCallouts({
    explicit: [{ ref: 7, atMm: [5, 5, 0] }],
    checks: [],
    parts: [],
    view: "front",
    autoAnchors: true,
  });
  assert.match(binding.notices.join(" "), /零件口径不适用/u);
  assert.deepEqual(
    binding.bindings.map(item => item.partIndex),
    [null],
  );
  assert.equal(binding.annotations.length, 1, "无零件时不得凭空造自动件号");
});

test("C-1 口径：历史载荷（无零件事实）⇒ 声明「未核对」，不得声称「模型没有 solid」", () => {
  const binding = bindCallouts({
    explicit: [{ ref: 7, atMm: [5, 5, 0] }],
    checks: [],
    parts: [],
    view: "front",
    autoAnchors: false,
    partFactsAvailable: false,
  });
  assert.match(binding.notices.join(" "), /不含零件事实/u);
  assert.doesNotMatch(binding.notices.join(" "), /模型没有 solid/u, "没测 ≠ 测得没有");
});

test("C-1 口径：模型只有 1 个 solid ⇒ 归属无歧义（按唯一零件记录），不适用时如实声明", () => {
  const binding = bindCallouts({
    explicit: [{ ref: 7, atMm: [5, 5, 0] }],
    checks: [CHECK_ON_A],
    parts: [PART_A],
    view: "front",
    autoAnchors: true,
  });
  assert.match(binding.notices.join(" "), /只有 1 个 solid/u);
  assert.equal(binding.bindings[0]!.partIndex, 0);
});

test("C-1 锚点外推：贴边时沿包围盒外法向推出；严格在内部时不挪点（交给 C15 报）", () => {
  const outset = anchorOutsetMm([0, 0], { min: [-10, 0], max: [0, 40] });
  assert.deepEqual(outset, [CAD_ANCHOR_OUTSET_MM, -CAD_ANCHOR_OUTSET_MM]);
  assert.deepEqual(anchorOutsetMm([-5, 20], { min: [-10, 0], max: [0, 40] }), [0, 0]);
});

// ---------------------------------------------------------------------------
// C-1：C14 / C15 规则
// ---------------------------------------------------------------------------

test("C-1 C14：锚点不落在任何零件上 ⇒ warn（不静默画一条指错零件的引线）", () => {
  const table = loadTable("plate-front.json");
  const findings = checkCadProjection({
    table,
    hiddenLines: false,
    anchorChecks: [
      { point: [500, 500, 500], ownerPart: null, onPart: false, nearestPart: 0, nearestSurfaceDistanceMm: 9 },
    ],
  });
  const c14 = findings.find(finding => finding.rule === "C14");
  assert.ok(c14, "必须报出 C14");
  assert.equal(c14!.severity, "warn");
  assert.match(c14!.message, /不落在任何零件上/u);
});

test("C-1 C14：没有锚点测量 ⇒ 判据不适用（不报「通过」，也不误报）", () => {
  const table = loadTable("plate-front.json");
  const findings = checkCadProjection({ table, hiddenLines: false });
  assert.equal(
    findings.find(finding => finding.rule === "C14"),
    undefined,
  );
});

test("C-1 C15：锚点投影落在零件轮廓内部 ⇒ warn（引线会横穿零件面）", () => {
  const table = loadTable("plate-front.json");
  const findings = checkCadProjection({
    table,
    hiddenLines: false,
    anchorChecks: [CHECK_ON_A],
    bindings: [{ ref: 10, partIndex: 0, anchorMm: [5, 5, 0], source: "explicit", outsetApplied: false }],
    parts: [
      {
        ...PART_A,
        views: {
          front: {
            projectedBBox: { min: [-100, -100], max: [100, 100] },
            suggestedAnchor: [0, 0, 0],
            suggestedAnchorProjected: [0, 0],
          },
        },
      },
    ],
  });
  const c15 = findings.find(finding => finding.rule === "C15");
  assert.ok(c15, "必须报出 C15");
  assert.equal(c15!.severity, "warn");
});

// ---------------------------------------------------------------------------
// C-3：剖面线方向交替（GB/T 4457.5）
// ---------------------------------------------------------------------------

test("C-3 剖面线：方向角可参数化（45° 与 135° 的线段方向确实不同）", () => {
  const square: [number, number][][] = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ];
  const forward = hatchPolylines(square, 2.5, { angleDeg: 45 });
  const backward = hatchPolylines(square, 2.5, { angleDeg: 135 });
  assert.ok(forward.length > 0 && backward.length > 0);
  const angleOf = (segment: [number, number][]): number => {
    const degrees = (Math.atan2(segment[1][1] - segment[0][1], segment[1][0] - segment[0][0]) * 180) / Math.PI;
    return Math.round(((degrees % 180) + 180) % 180);
  };
  assert.deepEqual([...new Set(forward.map(angleOf))], [45]);
  assert.deepEqual([...new Set(backward.map(angleOf))], [135]);
});

test("C-3 相邻判定：剖切面按几何邻近（投影质心）排序", () => {
  const faces: [number, number][][][] = [
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ],
    [
      [
        [50, 0],
        [60, 0],
        [60, 10],
        [50, 10],
      ],
    ],
    [
      [
        [25, 0],
        [35, 0],
        [35, 10],
        [25, 10],
      ],
    ],
  ];
  const ordered = orderCutFacesByProximity(faces, point => point);
  assert.deepEqual(
    ordered.map(face => face[0]![0]![0]),
    [0, 25, 50],
    "按投影质心沿 x 排序（相邻材料区域依次排开）",
  );
});

test("C-3 渲染：两个剖切面 ⇒ 剖面线方向相反（相邻零件可区分）", () => {
  const table = loadTable("plate-section-top.json");
  const first = table.cutFaces![0]!;
  const shifted = {
    loops: first.loops.map(loop => loop.map(point => [point[0] + 100, point[1], point[2]] as [number, number, number])),
  };
  const twoFaces: CadEdgeTable = { ...table, cutFaces: [first, shifted] };
  const render = renderCadSvg(twoFaces, { figureNo: 1, hiddenLines: false });
  assert.equal(render.cutFaces, 2);
  assert.deepEqual(render.hatchAnglesDeg, [45, 135]);
  assert.ok(render.hatchSegments > 0);
});

// ---------------------------------------------------------------------------
// manifest：件号 → 零件序号 → 锚点坐标可查
// ---------------------------------------------------------------------------

test("C-1 manifest：记录「件号 → 零件序号 → 锚点坐标」的对应（下游不必猜）", () => {
  const binding = bindCallouts({
    explicit: [{ ref: 10, atMm: [5, 5, 0] }],
    checks: [CHECK_ON_A],
    parts: [PART_A, PART_B],
    view: "front",
    autoAnchors: true,
  });
  const manifest = buildCadStructureManifest({
    figureNo: 3,
    stepPath: "/tmp/x.step",
    parts: [PART_A, PART_B],
    views: [
      {
        view: "front",
        file: "x-fig3-front.svg",
        geometry: {
          scale: 1,
          width_mm: 100,
          height_mm: 80,
          visible_edges: 11,
          hidden_edges: 4,
          cut_faces: 0,
          hatch_segments: 0,
        },
        bindings: binding.bindings,
      },
    ],
  });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.parts.length, 2);
  assert.deepEqual(manifest.views[0]!.callouts, [
    { ref: 10, partIndex: 0, anchorMm: [5, 5, 0], source: "explicit" },
    { ref: 1, partIndex: 1, anchorMm: [50, 0, 0], source: "auto" },
  ]);
});

// ---------------------------------------------------------------------------
// 脚本侧：探针与零件事实随脚本交付
// ---------------------------------------------------------------------------

test("C-1 脚本：显式锚点探针随脚本下发（脚本侧按零件真实几何核对归属）", () => {
  const script = buildProjectionScript({
    stepPath: "/tmp/x.step",
    view: "front",
    anchorProbes: [[5, 5, 0]],
  });
  assert.match(script, /ANCHOR_PROBES = \[/u);
  assert.match(script, /\[5, 5, 0\]/u);
  assert.match(script, /def _anchor_checks\(shape\):/u);
  assert.match(script, /def _surface_distance\(solid, point\):/u, "到表面的距离必须问壳体（实体对内部点返回 0）");
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
      `comp = Part.makeCompound([a, b])`,
      `comp.exportStep(${JSON.stringify(stepPath)})`,
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync(FREECAD!.cmd, [scriptPath]);
  return stepPath;
}

test("真机：2 个 solid 的模型 ⇒ 多视图一次产出 + 零件事实 + 锚点归属（无 FreeCAD 自动 skip）", {
  skip: FREECAD === undefined ? "freecadcmd not installed" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-cad-c-"));
  const stepPath = makeTwoSolidStep(dir);
  const outcome = await projectCadViews({
    cmd: FREECAD!.cmd,
    stepPath,
    views: ["front", "top"],
    annotations: [{ ref: 10, atMm: [5, 5, 0] }],
    autoAnchors: true,
    figureNo: 1,
    hiddenLines: false,
  });
  assert.equal(outcome.views.length, 2, "一次运行产出两个视图");
  assert.deepEqual(
    outcome.views.map(view => view.view),
    ["front", "top"],
  );
  assert.equal(outcome.parts.length, 2, "两个 solid ⇒ 两份零件事实");
  const [first, second] = outcome.parts;
  assert.ok(first && second);
  assert.deepEqual(first.bbox.min, [0, 0, 0]);
  assert.deepEqual(first.bbox.max, [40, 30, 10]);
  assert.equal(first.volume, 12000);
  assert.ok(first.area > 0);
  assert.ok(first.views.front?.suggestedAnchor, "每零件每视图都有建议锚点");
  // 显式锚点归属到零件 0；零件 1 自动补件号
  assert.deepEqual(
    outcome.views[0]!.bindings.map(item => [item.ref, item.partIndex]),
    [
      [10, 0],
      [1, 1],
    ],
  );
  // 显式锚点落在零件 0 的表面上 ⇒ 不报 C14
  assert.equal(
    outcome.views[0]!.findings.find(finding => finding.rule === "C14"),
    undefined,
  );
});

test("真机：锚点落在任何零件之外 ⇒ C14 报出（不静默画指错零件的引线）（无 FreeCAD 自动 skip）", {
  skip: FREECAD === undefined ? "freecadcmd not installed" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-cad-c2-"));
  const stepPath = makeTwoSolidStep(dir);
  const outcome = await projectCadViews({
    cmd: FREECAD!.cmd,
    stepPath,
    views: ["front"],
    annotations: [{ ref: 99, atMm: [35, 25, 20] }],
    autoAnchors: false,
    figureNo: 1,
    hiddenLines: false,
  });
  const c14 = outcome.views[0]!.findings.find(finding => finding.rule === "C14");
  assert.ok(c14, "必须报出 C14");
  assert.equal(c14!.severity, "warn");
});

test("真机：同一剖切面上的两个材料区域 ⇒ 剖面线方向相反（无 FreeCAD 自动 skip）", {
  skip: FREECAD === undefined ? "freecadcmd not installed" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-cad-c3-"));
  const scriptPath = join(dir, "make.py");
  const stepPath = join(dir, "two-plates.step");
  writeFileSync(
    scriptPath,
    [
      "import FreeCAD as App",
      "import Part",
      "a = Part.makeBox(40, 30, 10, App.Vector(0, 0, 0))",
      "b = Part.makeBox(40, 30, 10, App.Vector(60, 0, 0))",
      "comp = Part.makeCompound([a, b])",
      `comp.exportStep(${JSON.stringify(stepPath)})`,
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync(FREECAD!.cmd, [scriptPath]);
  const outcome = await projectCadViews({
    cmd: FREECAD!.cmd,
    stepPath,
    views: ["front"],
    sectionOffsetMm: 5,
    annotations: [],
    autoAnchors: false,
    figureNo: 1,
    hiddenLines: false,
  });
  const angles = outcome.views[0]!.render.hatchAnglesDeg;
  assert.equal(outcome.views[0]!.render.cutFaces, 2, "两个材料区域 ⇒ 两个剖切面");
  assert.deepEqual(angles, [45, 135], "相邻零件的剖面线方向相反（GB/T 4457.5）");
});
