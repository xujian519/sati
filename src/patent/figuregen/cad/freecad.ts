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
  type CadAxisImages,
  type CadEdge,
  type CadEdgeTable,
  type CadView,
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
};

/**
 * 生成投影脚本（Python，交给 `freecadcmd` 执行）。
 *
 * 脚本只做三件事：导入 STEP → `TechDraw.project` → 把可见/隐藏边离散化为 JSON 边表
 * （打印在定界标记之间）。**不画图、不产 SVG**——画由 Sati 自己的渲染契约负责。
 */
export function buildProjectionScript(options: ProjectionScriptOptions): string {
  const direction = VIEW_DIRECTIONS[options.view];
  const tolerance = options.toleranceMm ?? 0.5;
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
    "# 投影坐标系是 TechDraw 自己挑的（实测 front 视图里 u 对应 -Z）：用三个单位参考体",
    "# 分别投影，得到模型各轴在投影平面上的像，渲染侧据此对齐朝向。",
    "def _axis_image(vec):",
    "    probe = Part.makeBox(0.001, 0.001, 0.001, vec)",
    "    p0, p1, _, _ = TechDraw.project(probe, DIRECTION)",
    "    probe_edges = list(p0.Edges) + list(p1.Edges)",
    "    if not probe_edges:",
    "        raise SystemExit('参考体投影为空，无法确定投影坐标系朝向')",
    "    point = probe_edges[0].discretize(2)[0]",
    "    return [round(point.x, 6), round(point.y, 6)]",
    "",
    "visible0, visible1, hidden0, hidden1 = TechDraw.project(shape, DIRECTION)",
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
    "        'x': _axis_image(App.Vector(1, 0, 0)),",
    "        'y': _axis_image(App.Vector(0, 1, 0)),",
    "        'z': _axis_image(App.Vector(0, 0, 1)),",
    "    },",
    "    'edges': edges,",
    "    'curveKinds': kinds,",
    "}",
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
    curveKinds,
  };
}

/** 解析模型轴像（三个二维向量；缺失/非法即抛错——朝向无法确定时不出图）。 */
function parseAxes(raw: unknown): CadAxisImages {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("投影边表缺少 axes（模型轴像）");
  }
  const record = raw as Record<string, unknown>;
  const read = (key: "x" | "y" | "z"): [number, number] => {
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
  return { x: read("x"), y: read("y"), z: read("z") };
}

export type ProjectStepOptions = {
  /** freecadcmd 路径（由 `resolveFreecadCmd` 得到）。 */
  cmd: string;
  stepPath: string;
  view: CadView;
  toleranceMm?: number;
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
  const script = buildProjectionScript({
    stepPath: options.stepPath,
    view: options.view,
    ...(options.toleranceMm === undefined ? {} : { toleranceMm: options.toleranceMm }),
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
