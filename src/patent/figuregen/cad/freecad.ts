/**
 * src/patent/figuregen/cad — FreeCAD 无头投影（能力探测 + 脚本 + 运行 + 解析）。
 *
 * 实测结论（FreeCAD 1.1.3，`freecadcmd`，`App.GuiUp = 0`）：冷启动 0.18–0.19s；
 * `TechDraw.project(shape, dir)` 返回 `[可见 G0, 可见 G1, 隐藏 G0, 隐藏 G1]`；输出数值
 * 即毫米（Y 已由 `scale(1,-1)` 翻转，故**只需平移归一化、无需再翻一次**）；同输入两次
 * 结果一致（确定性）。
 *
 * 四类已实测的坑，本模块逐一处理：
 * 1. `freecadcmd` 会向 stdout 打版本横幅与统计 ⇒ 解析**只认定界标记之间**的内容；
 * 2. 无 GUI 只能用函数式 API（`Part` / `TechDraw.project`），**不走** `TechDraw::DrawPage`
 *    文档对象；
 * 3. 投影后的孔边是 `BSplineCurve`（不是 `Circle`）⇒ 一律按容差离散化为折线；
 * 4. 依赖 2.6GB 应用 ⇒ **不捆绑**、本机可选、`SATI_FREECAD_CMD` 显式路径（同 graphviz 先例）。
 *
 * 单测**不真跑 FreeCAD**：走注入的 `runner` + 录制的边表（与 dot 的注入先例一致）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAD_EDGE_TABLE_VERSION,
  CAD_SECTION_VIEWS,
  type CadAxisImages,
  type CadCutFace,
  type CadEdge,
  type CadEdgeTable,
  type CadSection,
  type CadView,
  isCadSectionView,
  isCadView,
} from "./types.js";

/** 显式指定 freecadcmd 路径的环境变量（优先于探测）。 */
export const FREECAD_CMD_ENV = "SATI_FREECAD_CMD";
/** 投影脚本默认超时（毫秒）。 */
export const CAD_DEFAULT_TIMEOUT_MS = 60_000;
/** 边数上限（超出判 fail-closed：大装配投影出图既不可辨也不可审）。 */
export const CAD_MAX_EDGES = 20_000;
/** 投影脚本输出边表的定界标记（stdout 混有横幅与统计，必须按标记截取）。 */
export const CAD_JSON_BEGIN = "SATI_CAD_JSON_BEGIN";
export const CAD_JSON_END = "SATI_CAD_JSON_END";

/** 常见安装位置（macOS 官方 app 包内；Windows/Linux 走 PATH 探测）。 */
const FREECAD_CANDIDATE_PATHS = [
  "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd",
  "/usr/local/bin/freecadcmd",
  "/usr/bin/freecadcmd",
];

export type FreecadProbe = {
  /** 可用的 freecadcmd 路径。 */
  cmd: string;
  /** 来源（环境变量 / 探测路径），供报告与诊断。 */
  source: string;
};

/**
 * 能力探测：`SATI_FREECAD_CMD` 显式路径优先，其次常见安装位置，
 * 再次 PATH 上的 `freecadcmd`（经 `which` 探测交给调用方）。
 * 全部落空返回 undefined（调用方 fail-closed 报错，不静默回退内置渲染器）。
 */
export function resolveFreecadCmd(
  env: NodeJS.ProcessEnv = process.env,
  options: { exists?: (path: string) => boolean } = {},
): FreecadProbe | undefined {
  const exists = options.exists ?? existsSync;
  const explicit = (env[FREECAD_CMD_ENV] ?? "").trim();
  if (explicit.length > 0) {
    if (!exists(explicit)) {
      throw new TypeError(`${FREECAD_CMD_ENV} 指向的文件不存在：${explicit}`);
    }
    return { cmd: explicit, source: FREECAD_CMD_ENV };
  }
  for (const candidate of FREECAD_CANDIDATE_PATHS) {
    if (exists(candidate)) return { cmd: candidate, source: `探测路径 ${candidate}` };
  }
  return undefined;
}

/** 视图方向向量（FreeCAD 坐标系；front 为 -Y）。 */
const VIEW_DIRECTIONS: Record<CadView, [number, number, number]> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  iso: [1, -1, 1],
};

export type ProjectionScriptOptions = {
  stepPath: string;
  view: CadView;
  /** 离散化容差（毫米）：越小越平滑、边表越大；0.5mm 对交付图足够。 */
  toleranceMm?: number;
  /**
   * 剖切（全剖视图）：剖切面垂直于视图方向、位于距模型原点该处（模型坐标沿视线方向的
   * 值，毫米）。仅轴对齐视图可剖切（`CAD_SECTION_VIEWS`）。
   */
  sectionOffsetMm?: number;
};

/**
 * 生成投影脚本（Python，交给 `freecadcmd` 执行）。
 *
 * 脚本只做三件事：导入 STEP → （可选）按半空间剖切 → `TechDraw.project` 并把可见/隐藏边
 * 离散化为 JSON 边表（打印在定界标记之间）。**不画图、不产 SVG、不投影剖切面**——画与
 * 投影都由 Sati 自己的契约负责（剖切面轮廓以模型坐标交给 Sati 侧投影）。
 */
export function buildProjectionScript(options: ProjectionScriptOptions): string {
  const direction = VIEW_DIRECTIONS[options.view];
  const tolerance = options.toleranceMm ?? 0.5;
  const section = options.sectionOffsetMm;
  if (section !== undefined && !isCadSectionView(options.view)) {
    throw new TypeError(`视图 ${options.view} 不能剖切（剖切要求轴对齐视图：${CAD_SECTION_VIEWS.join(", ")}）`);
  }
  const axisIndex = direction.findIndex(component => component !== 0);
  const sectionAxis = axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z";
  return [
    "# 由 Sati 生成（src/patent/figuregen/cad/freecad.ts）——只输出 JSON 边表，不产出图形。",
    "import json",
    "import FreeCAD as App",
    "import Part, TechDraw",
    "",
    `STEP_PATH = ${JSON.stringify(options.stepPath)}`,
    `VIEW = ${JSON.stringify(options.view)}`,
    `DIRECTION = App.Vector(${direction[0]}, ${direction[1]}, ${direction[2]})`,
    `TOLERANCE = ${tolerance}`,
    `SECTION_OFFSET = ${section === undefined ? "None" : String(section)}`,
    "",
    "def _discretize(edge):",
    "    length = edge.Length",
    "    count = int(max(2, min(64, length / TOLERANCE + 2)))",
    "    return [[round(p.x, 4), round(p.y, 4)] for p in edge.discretize(count)]",
    "",
    "shape = Part.Shape()",
    "shape.read(STEP_PATH)",
    "if shape.isNull():",
    "    raise SystemExit('STEP 读取失败或几何为空: ' + STEP_PATH)",
    "",
    "# 投影坐标系是 TechDraw 自己挑的（实测 front 视图里 u 对应 -Z）：用四个单位参考体",
    "# （原点 + 三轴）分别投影，得到模型原点与各轴在投影平面上的像。仅有轴像不足以定出",
    "# 仿射映射（三轴像含同一个未知平移），故原点像必须一并给出。",
    "def _probe(vec):",
    "    probe = Part.makeBox(0.001, 0.001, 0.001, vec)",
    "    p0, p1, _, _ = TechDraw.project(probe, DIRECTION)",
    "    probe_edges = list(p0.Edges) + list(p1.Edges)",
    "    if not probe_edges:",
    "        raise SystemExit('参考体投影为空，无法确定投影坐标系朝向')",
    "    point = probe_edges[0].discretize(2)[0]",
    "    return [round(point.x, 6), round(point.y, 6)]",
    "",
    "# 剖切（全剖视图）：保留远离观者的一侧（p·d ≤ offset），露出剖切面。",
    "# 剖切面轮廓另行以**模型坐标**输出（Sati 侧投影 + 纸面剖面线填充）。",
    "def _section(shape):",
    "    bb = shape.BoundBox",
    "    span = max(bb.XLength, bb.YLength, bb.ZLength, 1.0)",
    "    margin = span * 2 + 10",
    "    low = [bb.XMin - margin, bb.YMin - margin, bb.ZMin - margin]",
    "    high = [bb.XMax + margin, bb.YMax + margin, bb.ZMax + margin]",
    `    axis = ${axisIndex}`,
    "    sign = 1 if DIRECTION.x + DIRECTION.y + DIRECTION.z > 0 else -1",
    "    # 保留 sign*coord ≤ sign*offset 的一侧（远离观者）",
    "    if sign > 0:",
    "        high[axis] = SECTION_OFFSET",
    "    else:",
    "        low[axis] = SECTION_OFFSET",
    "    half = Part.makeBox(high[0]-low[0], high[1]-low[1], high[2]-low[2], App.Vector(low[0], low[1], low[2]))",
    "    kept = shape.common(half)",
    "    if kept.isNull() or not kept.Faces:",
    "        raise SystemExit('剖切后几何为空（剖切面在模型范围之外？offset=' + str(SECTION_OFFSET) + '）')",
    "    unit = App.Vector(0, 0, 0)",
    "    if axis == 0:",
    "        unit = App.Vector(sign, 0, 0)",
    "    elif axis == 1:",
    "        unit = App.Vector(0, sign, 0)",
    "    else:",
    "        unit = App.Vector(0, 0, sign)",
    "    faces = []",
    "    for face in kept.Faces:",
    "        if face.Surface.__class__.__name__ != 'Plane':",
    "            continue",
    "        normal = face.normalAt(0, 0)",
    "        if abs(normal.dot(unit) - 1.0) > 1e-6:",
    "            continue  # 非剖切面：法向须与视线方向一致（朝观者）",
    "        if abs(face.CenterOfMass.dot(unit) - SECTION_OFFSET * sign) > 1e-6:",
    "            continue",
    "        loops = []",
    "        wires = [face.OuterWire]",
    "        for wire in face.Wires:",
    "            if not wire.isSame(face.OuterWire):",
    "                loops.append(wire)",
    "        loops = [face.OuterWire] + loops",
    "        loops = [[[round(p.x, 4), round(p.y, 4), round(p.z, 4)] for p in _loop_points(w)] for w in loops]",
    "        faces.append({'loops': loops})",
    "    return kept, faces",
    "",
    "def _loop_points(wire):",
    "    # 环必须连成**闭合回路**：wire.OrderedEdges 只是「边集合已排序」，并不保证首尾相接地",
    "    # 串成走向（实测剖切面的边序是乱序）⇒ 按端点做连通性搜索逐边拼接，并在必要时反转",
    "    # （边的参数方向未必与环走向一致）。拼不成环即 fail-loud：宁可不输出，也不画错剖面线。",
    "    remaining = [list(e.discretize(int(max(2, min(64, e.Length / 0.2 + 2))))) for e in wire.Edges]",
    "    if not remaining:",
    "        raise SystemExit('剖切面轮廓环为空')",
    "    current = remaining.pop(0)",
    "    points = list(current)",
    "    end = current[-1]",
    "    while remaining:",
    "        found = None",
    "        for index, segment in enumerate(remaining):",
    "            if (segment[0] - end).Length <= 1e-6 or (segment[-1] - end).Length <= 1e-6:",
    "                found = index",
    "                break",
    "        if found is None:",
    "            raise SystemExit('剖切面轮廓环不闭合（边的端点接不上），拒绝输出可能错误的剖面线')",
    "        segment = remaining.pop(found)",
    "        if (segment[0] - end).Length > (segment[-1] - end).Length:",
    "            segment.reverse()",
    "        points.extend(segment)",
    "        end = points[-1]",
    "    if (points[0] - points[-1]).Length > 1e-3:",
    "        raise SystemExit('剖切面轮廓环未回到起点（几何异常），拒绝输出可能错误的剖面线')",
    "    return points",
    "",
    "cut_faces = []",
    "projected = shape",
    "if SECTION_OFFSET is not None:",
    "    projected, cut_faces = _section(shape)",
    "",
    "visible0, visible1, hidden0, hidden1 = TechDraw.project(projected, DIRECTION)",
    "edges = []",
    "kinds = {}",
    "for kind, group in (('visible', visible0), ('visible', visible1), ('hidden', hidden0), ('hidden', hidden1)):",
    "    for edge in group.Edges:",
    "        points = _discretize(edge)",
    "        if len(points) < 2:",
    "            continue",
    "        curve = type(edge.Curve).__name__",
    "        kinds[curve] = kinds.get(curve, 0) + 1",
    "        edges.append({'kind': kind, 'curve': curve, 'closed': bool(edge.isClosed()), 'points': points})",
    "",
    "if not edges:",
    "    raise SystemExit('投影未产生任何边（几何不可见或方向错误）: ' + VIEW)",
    "",
    "payload = {",
    `    'version': ${CAD_EDGE_TABLE_VERSION},`,
    "    'view': VIEW,",
    "    'units': 'mm',",
    "    'axes': {",
    "        'origin': _probe(App.Vector(0, 0, 0)),",
    "        'x': _probe(App.Vector(1, 0, 0)),",
    "        'y': _probe(App.Vector(0, 1, 0)),",
    "        'z': _probe(App.Vector(0, 0, 1)),",
    "    },",
    "    'edges': edges,",
    "    'curveKinds': kinds,",
    "}",
    "if SECTION_OFFSET is not None:",
    `    lo = round(min(getattr(shape.BoundBox, '${sectionAxis}Min'), getattr(shape.BoundBox, '${sectionAxis}Max')), 4)`,
    `    hi = round(max(getattr(shape.BoundBox, '${sectionAxis}Min'), getattr(shape.BoundBox, '${sectionAxis}Max')), 4)`,
    "    signed = [lo, hi] if DIRECTION.x + DIRECTION.y + DIRECTION.z > 0 else [-hi, -lo]",
    "    payload['section'] = {'offset_mm': SECTION_OFFSET, 'model_extent_mm': signed}",
    "    payload['cutFaces'] = cut_faces",
    `print(${JSON.stringify(CAD_JSON_BEGIN)})`,
    "print(json.dumps(payload, ensure_ascii=False))",
    `print(${JSON.stringify(CAD_JSON_END)})`,
    "",
  ].join("\n");
}

/** 进程运行器契约（注入点：单测不真跑 FreeCAD）。 */
export type CadRunner = (
  cmd: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** 默认运行器：spawn + 超时强杀（与 graphviz 的 runDot 同构）。 */
export const defaultCadRunner: CadRunner = async (cmd, args, options) => {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`freecadcmd 超时（${options.timeoutMs}ms）`));
    }, options.timeoutMs);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
  });
};

/**
 * 从 stdout 截取并解析边表（严格按定界标记；缺失/越界/结构非法一律抛错）。
 *
 * `freecadcmd` 会把版本横幅与统计打在 stdout，故**不能**直接 `JSON.parse(stdout)`。
 */
export function parseProjectionOutput(stdout: string): CadEdgeTable {
  const begin = stdout.indexOf(CAD_JSON_BEGIN);
  const end = stdout.indexOf(CAD_JSON_END);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new TypeError(`投影输出缺少定界标记（${CAD_JSON_BEGIN}/${CAD_JSON_END}）——无法定位边表`);
  }
  const body = stdout.slice(begin + CAD_JSON_BEGIN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new TypeError(`投影边表不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("投影边表顶层应为对象");
  }
  const table = parsed as Record<string, unknown>;
  if (table.version !== CAD_EDGE_TABLE_VERSION) {
    throw new TypeError(`投影边表版本不支持: ${String(table.version)}（期望 ${CAD_EDGE_TABLE_VERSION}）`);
  }
  if (!isCadView(table.view)) {
    throw new TypeError(`投影边表视图非法: ${String(table.view)}`);
  }
  if (!Array.isArray(table.edges)) {
    throw new TypeError("投影边表缺少 edges 数组");
  }
  const edges: CadEdge[] = [];
  for (const [index, entry] of table.edges.entries()) {
    const edge = entry as Record<string, unknown>;
    if (edge.kind !== "visible" && edge.kind !== "hidden") {
      throw new TypeError(`投影边表 edges[${index}].kind 应为 visible/hidden`);
    }
    if (!Array.isArray(edge.points) || edge.points.length < 2) {
      throw new TypeError(`投影边表 edges[${index}].points 至少应有 2 个点`);
    }
    const points: [number, number][] = [];
    for (const point of edge.points) {
      if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== "number" || typeof point[1] !== "number") {
        throw new TypeError(`投影边表 edges[${index}] 的点应为 [number, number]`);
      }
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new TypeError(`投影边表 edges[${index}] 含非有限坐标`);
      }
      points.push([point[0], point[1]]);
    }
    edges.push({
      kind: edge.kind,
      curve: typeof edge.curve === "string" ? edge.curve : "unknown",
      closed: edge.closed === true,
      points,
    });
  }
  const axes = parseAxes(table.axes);
  const section = parseSection(table.section);
  const cutFaces = parseCutFaces(table.cutFaces);
  if (section === undefined && cutFaces !== undefined) {
    throw new TypeError("投影边表含 cutFaces 但缺少 section 参数（剖切面轮廓的来源不可追溯）");
  }
  if (section !== undefined && cutFaces === undefined) {
    throw new TypeError("投影边表声明了剖切（section）但没有剖切面轮廓（cutFaces）——剖面线无从绘制");
  }
  const curveKinds: Record<string, number> = {};
  const rawKinds = table.curveKinds;
  if (rawKinds !== null && typeof rawKinds === "object" && !Array.isArray(rawKinds)) {
    for (const [key, value] of Object.entries(rawKinds as Record<string, unknown>)) {
      if (typeof value === "number") curveKinds[key] = value;
    }
  }
  return {
    version: CAD_EDGE_TABLE_VERSION,
    view: table.view,
    units: "mm",
    axes,
    edges,
    ...(section === undefined ? {} : { section }),
    ...(cutFaces === undefined ? {} : { cutFaces }),
    curveKinds,
  };
}

/** 解析剖切参数（缺省 = 整视图；出现但结构非法即抛错）。 */
function parseSection(raw: unknown): CadSection | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("投影边表 section 应为对象");
  }
  const record = raw as Record<string, unknown>;
  const offset = record.offset_mm;
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    throw new TypeError("投影边表 section.offset_mm 应为数字");
  }
  const extent = record.model_extent_mm;
  if (
    !Array.isArray(extent) ||
    extent.length < 2 ||
    typeof extent[0] !== "number" ||
    typeof extent[1] !== "number" ||
    !Number.isFinite(extent[0]) ||
    !Number.isFinite(extent[1])
  ) {
    throw new TypeError("投影边表 section.model_extent_mm 应为 [number, number]");
  }
  return { offset_mm: offset, model_extent_mm: [extent[0], extent[1]] };
}

/** 解析剖切面轮廓（模型坐标多环；每个面至少一个环、每环至少 3 点且须闭合）。 */
function parseCutFaces(raw: unknown): CadCutFace[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new TypeError("投影边表 cutFaces 应为数组");
  }
  return raw.map((entry, index) => {
    const loops = (entry as Record<string, unknown> | null)?.["loops"];
    if (!Array.isArray(loops) || loops.length === 0) {
      throw new TypeError(`投影边表 cutFaces[${index}].loops 应为非空数组`);
    }
    return {
      loops: loops.map((loop, loopIndex) => {
        if (!Array.isArray(loop) || loop.length < 3) {
          throw new TypeError(`投影边表 cutFaces[${index}].loops[${loopIndex}] 至少应有 3 个点`);
        }
        const parsed = loop.map(point => {
          if (
            !Array.isArray(point) ||
            point.length < 3 ||
            typeof point[0] !== "number" ||
            typeof point[1] !== "number" ||
            typeof point[2] !== "number" ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            !Number.isFinite(point[2])
          ) {
            throw new TypeError(`投影边表 cutFaces[${index}].loops[${loopIndex}] 的点应为 [number, number, number]`);
          }
          return [point[0], point[1], point[2]] as [number, number, number];
        });
        // 闭合性必须成立：不闭合的环会被扫描线按"隐式闭合边"处理，剖面线会画到剖切面之外
        // （实测踩过：边序乱序时不拼接会留下一条跨图的假闭合边）。
        const first = parsed[0]!;
        const last = parsed[parsed.length - 1]!;
        if (Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) > 1e-3) {
          throw new TypeError(
            `投影边表 cutFaces[${index}].loops[${loopIndex}] 未闭合（首尾点相距超过 0.001mm）——` +
              "剖面线会画到剖切面之外，拒绝使用该边表",
          );
        }
        return parsed;
      }),
    };
  });
}

/** 解析模型原点与三轴像（缺失/非法即抛错——映射无法确定时不出图）。 */
function parseAxes(raw: unknown): CadAxisImages {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("投影边表缺少 axes（模型原点/轴像）");
  }
  const record = raw as Record<string, unknown>;
  const read = (key: "origin" | "x" | "y" | "z"): [number, number] => {
    const value = record[key];
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      typeof value[0] !== "number" ||
      typeof value[1] !== "number" ||
      !Number.isFinite(value[0]) ||
      !Number.isFinite(value[1])
    ) {
      throw new TypeError(`投影边表 axes.${key} 应为 [number, number]`);
    }
    return [value[0], value[1]];
  };
  return { origin: read("origin"), x: read("x"), y: read("y"), z: read("z") };
}

export type ProjectStepOptions = {
  /** freecadcmd 路径（由 `resolveFreecadCmd` 得到）。 */
  cmd: string;
  stepPath: string;
  view: CadView;
  toleranceMm?: number;
  /** 剖切（全剖视图）：见 `ProjectionScriptOptions.sectionOffsetMm`。 */
  sectionOffsetMm?: number;
  timeoutMs?: number;
  /** 注入点：单测传假运行器（不真跑 FreeCAD）。 */
  runner?: CadRunner;
};

/**
 * 跑一次无头投影，返回边表（失败 fail-closed：绝不静默回退到别的渲染器）。
 *
 * 脚本经**临时文件**交付：`freecadcmd` 的位置参数才是"要执行的脚本"，而 `-c` 是
 * "console 模式"开关（**不是** `python -c`）——把脚本内容当参数传会被当作文件名。
 * 临时目录随调用清理（含失败路径）。
 */
export async function projectStep(options: ProjectStepOptions): Promise<CadEdgeTable> {
  const runner = options.runner ?? defaultCadRunner;
  if (options.sectionOffsetMm !== undefined && !isCadSectionView(options.view)) {
    throw new TypeError(`视图 ${options.view} 不能剖切（剖切要求轴对齐视图：${CAD_SECTION_VIEWS.join(", ")}）`);
  }
  const script = buildProjectionScript({
    stepPath: options.stepPath,
    view: options.view,
    ...(options.toleranceMm === undefined ? {} : { toleranceMm: options.toleranceMm }),
    ...(options.sectionOffsetMm === undefined ? {} : { sectionOffsetMm: options.sectionOffsetMm }),
  });
  const dir = await mkdtemp(join(tmpdir(), "sati-cad-"));
  const scriptPath = join(dir, "project.py");
  try {
    await writeFile(scriptPath, script, "utf8");
    const { stdout, stderr, code } = await runner(options.cmd, [scriptPath], {
      timeoutMs: options.timeoutMs ?? CAD_DEFAULT_TIMEOUT_MS,
    });
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-6).join(" | ");
      throw new Error(`freecadcmd 投影失败（退出码 ${String(code)}）：${detail}`);
    }
    const table = parseProjectionOutput(stdout);
    if (table.edges.length > CAD_MAX_EDGES) {
      throw new Error(`投影边数 ${table.edges.length} 超过上限 ${CAD_MAX_EDGES}——请改用更小的装配或分次投影`);
    }
    return table;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
