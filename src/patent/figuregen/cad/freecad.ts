/**
 * src/patent/figuregen/cad — FreeCAD 无头投影（能力探测 + 运行 + 解析）。
 *
 * 实测结论（FreeCAD 1.1.3，`freecadcmd`，`App.GuiUp = 0`）：冷启动 0.18–0.19s；
 * `TechDraw.project(shape, dir)` 返回 `[可见 G0, 可见 G1, 隐藏 G0, 隐藏 G1]`；输出数值
 * 即毫米（Y 已由 `scale(1,-1)` 翻转，故**只需平移归一化、无需再翻一次**）；同输入两次
 * 结果一致（确定性）。
 *
 * 六类已实测的坑，本模块逐一处理：
 * 1. `freecadcmd` 会向 stdout 打版本横幅与统计 ⇒ 解析**只认定界标记之间**的内容；
 * 2. 无 GUI 只能用函数式 API（`Part` / `TechDraw.project`），**不走** `TechDraw::DrawPage`
 *    文档对象；
 * 3. 投影后的孔边是 `BSplineCurve`（不是 `Circle`）⇒ 一律按容差离散化为折线；
 * 4. 依赖 2.6GB 应用 ⇒ **不捆绑**、本机可选、`SATI_FREECAD_CMD` 显式路径（同 graphviz 先例）；
 * 5. `raise SystemExit('…')` 的消息会被 `freecadcmd` **吞掉**（只剩退出码），而非 `SystemExit`
 *    逃逸时**退出码反而是 0** ⇒ 脚本统一走 `_fail()`（stderr 标记 + `sys.exit(1)`），主流程收进
 *    `_main()` 并由顶层兜底，使「失败 ⇒ 非零退出码 + 消息可达」成为契约；
 * 6. 于是失败仍可能以「**退出码 0** + 真因只在 stderr」的形态到达 ⇒ 消费侧解析失败时**不得**
 *    丢弃 stderr（`describeCadFailure`）：退出码不是成功的充分条件。
 *
 * **与 DSH 的对应关系**：DSH 的 `freecad-renderer.ts` 同样"一次进程跑多个视图"，同样把
 * 锚点核对放在脚本侧。本模块的差异是**产物契约**：DSH 让脚本直接吐 SVG 片段与 manifest，
 * 本模块让脚本只吐 JSON 边表 + 零件事实 + 锚点归属，画图与版式仍由 Sati 侧负责
 * （黑白不变式、`data-ref`、A4 版式、回读全部复用既有交付契约）。
 *
 * 单测**不真跑 FreeCAD**：走注入的 `runner` + 录制的边表（与 dot 的注入先例一致）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAD_ERROR_MARKER } from "./error-marker.js";
import { buildProjectionScript } from "./freecad-script.js";
import {
  CAD_EDGE_TABLE_VERSION,
  CAD_PROJECTION_VERSION,
  type CadAnchorCheck,
  type CadAxisImages,
  type CadCutFace,
  type CadEdge,
  type CadEdgeTable,
  type CadPartFact,
  type CadProjectionPayload,
  type CadSection,
  type CadView,
  isCadSectionView,
  isCadView,
} from "./types.js";

export { CAD_ERROR_MARKER } from "./error-marker.js";
export { buildProjectionScript, type ProjectionScriptOptions } from "./freecad-script.js";

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
 * 从 stdout 截取并解析投影产物（严格按定界标记；缺失/越界/结构非法一律抛错）。
 *
 * `freecadcmd` 会把版本横幅与统计打在 stdout，故**不能**直接 `JSON.parse(stdout)`。
 *
 * 兼容两种载荷：
 * - **v3**（当前）：`{version:3, views:[…], parts:[…], anchors:[…]}`——多视图 + 零件事实；
 * - **v2**（历史单视图平铺）：`{version:2, view, axes, edges, …}`——仍可解析，
 *   零件与锚点为空（旧产物没有这些事实，如实留空而不是编造）。
 */
export function parseProjectionPayload(stdout: string): CadProjectionPayload {
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
  const version = table.version;
  if (version === CAD_PROJECTION_VERSION) {
    return {
      version,
      views: parseViews(table.views),
      parts: parseParts(table.parts),
      anchors: parseAnchors(table.anchors),
    };
  }
  if (version === CAD_EDGE_TABLE_VERSION) {
    // 历史单视图载荷：解析为"只有主视图、没有零件事实"的产物
    return { version, views: [parseEdgeTable(table)], parts: [], anchors: [] };
  }
  throw new TypeError(
    `投影边表版本不支持: ${String(version)}（期望 ${CAD_PROJECTION_VERSION} 或 ${CAD_EDGE_TABLE_VERSION}）`,
  );
}

/**
 * 解析投影产物并取**主视图**（第一个视图）的边表。
 *
 * 保留这个函数是为了让"单视图"路径的既有调用方不必改：它与 `parseProjectionPayload`
 * 共用同一套逐视图校验（`parseEdgeTable`），不存在两套口径。
 */
export function parseProjectionOutput(stdout: string): CadEdgeTable {
  const payload = parseProjectionPayload(stdout);
  const primary = payload.views[0];
  if (primary === undefined) {
    throw new TypeError("投影产物没有任何视图");
  }
  return primary;
}

/** 解析多视图列表（v3 载荷）。 */
function parseViews(raw: unknown): CadEdgeTable[] {
  if (!Array.isArray(raw)) {
    throw new TypeError("投影产物缺少 views 数组");
  }
  if (raw.length === 0) {
    throw new TypeError("投影产物的 views 为空");
  }
  return raw.map(entry => parseEdgeTable(entry as Record<string, unknown>));
}

/** 解析单个视图的边表（v2 平铺与 v3 嵌套共用）。 */
function parseEdgeTable(table: Record<string, unknown>): CadEdgeTable {
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

/** 解析每零件几何事实（v3 载荷）。 */
function parseParts(raw: unknown): CadPartFact[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError("投影产物 parts 应为数组");
  }
  return raw.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const partIndex = record.index;
    if (typeof partIndex !== "number" || !Number.isInteger(partIndex) || partIndex < 0) {
      throw new TypeError(`投影产物 parts[${index}].index 应为非负整数`);
    }
    const bbox = parsePartBBox(record.bbox, index);
    const centroid = parseTriple(record.centroid, `parts[${index}].centroid`);
    const area = record.area;
    const volume = record.volume;
    if (typeof area !== "number" || !Number.isFinite(area)) {
      throw new TypeError(`投影产物 parts[${index}].area 应为数字`);
    }
    if (typeof volume !== "number" || !Number.isFinite(volume)) {
      throw new TypeError(`投影产物 parts[${index}].volume 应为数字`);
    }
    const views = parsePartViews(record.views, index);
    return { index: partIndex, bbox, centroid, area, volume, views };
  });
}

/** 解析零件包围盒（模型坐标）。 */
function parsePartBBox(raw: unknown, index: number): { min: [number, number, number]; max: [number, number, number] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`投影产物 parts[${index}].bbox 应为对象`);
  }
  const record = raw as Record<string, unknown>;
  return {
    min: parseTriple(record.min, `parts[${index}].bbox.min`),
    max: parseTriple(record.max, `parts[${index}].bbox.max`),
  };
}

/** 解析零件的逐视图投影事实。 */
function parsePartViews(raw: unknown, index: number): Record<string, CadPartFact["views"][string]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`投影产物 parts[${index}].views 应为对象`);
  }
  const views: Record<string, CadPartFact["views"][string]> = {};
  for (const [viewName, value] of Object.entries(raw as Record<string, unknown>)) {
    const record = value as Record<string, unknown>;
    const bboxRaw = record.projectedBBox as Record<string, unknown> | undefined;
    if (bboxRaw === null || typeof bboxRaw !== "object" || Array.isArray(bboxRaw)) {
      throw new TypeError(`投影产物 parts[${index}].views.${viewName}.projectedBBox 应为对象`);
    }
    const min = parsePair(bboxRaw.min, `parts[${index}].views.${viewName}.projectedBBox.min`);
    const max = parsePair(bboxRaw.max, `parts[${index}].views.${viewName}.projectedBBox.max`);
    const suggestedAnchor = parseTriple(record.suggestedAnchor, `parts[${index}].views.${viewName}.suggestedAnchor`);
    const suggestedAnchorProjected = parsePair(
      record.suggestedAnchorProjected,
      `parts[${index}].views.${viewName}.suggestedAnchorProjected`,
    );
    views[viewName] = { projectedBBox: { min, max }, suggestedAnchor, suggestedAnchorProjected };
  }
  return views;
}

/** 解析显式锚点的归属核对结果（v3 载荷）。 */
function parseAnchors(raw: unknown): CadAnchorCheck[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError("投影产物 anchors 应为数组");
  }
  return raw.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const point = parseTriple(record.point, `anchors[${index}].point`);
    const ownerRaw = record.ownerPart;
    if (ownerRaw !== null && (typeof ownerRaw !== "number" || !Number.isInteger(ownerRaw) || ownerRaw < 0)) {
      throw new TypeError(`投影产物 anchors[${index}].ownerPart 应为非负整数或 null`);
    }
    const onPart = record.onPart;
    if (typeof onPart !== "boolean") {
      throw new TypeError(`投影产物 anchors[${index}].onPart 应为布尔`);
    }
    const surfaceDistanceMm = record.surfaceDistanceMm;
    const bboxDistanceMm = record.bboxDistanceMm;
    const nearestPart = record.nearestPart;
    const nearestSurfaceDistanceMm = record.nearestSurfaceDistanceMm;
    return {
      point,
      ownerPart: ownerRaw === null ? null : ownerRaw,
      onPart,
      ...(typeof surfaceDistanceMm === "number" ? { surfaceDistanceMm } : {}),
      ...(typeof bboxDistanceMm === "number" ? { bboxDistanceMm } : {}),
      ...(typeof nearestPart === "number" ? { nearestPart } : {}),
      ...(typeof nearestSurfaceDistanceMm === "number" ? { nearestSurfaceDistanceMm } : {}),
    };
  });
}

/** 解析三维有限数数组。 */
function parseTriple(raw: unknown, label: string): [number, number, number] {
  if (
    !Array.isArray(raw) ||
    raw.length !== 3 ||
    typeof raw[0] !== "number" ||
    typeof raw[1] !== "number" ||
    typeof raw[2] !== "number" ||
    !Number.isFinite(raw[0]) ||
    !Number.isFinite(raw[1]) ||
    !Number.isFinite(raw[2])
  ) {
    throw new TypeError(`投影产物 ${label} 应为 [number, number, number]`);
  }
  return [raw[0], raw[1], raw[2]];
}

/** 解析二维有限数数组。 */
function parsePair(raw: unknown, label: string): [number, number] {
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== "number" ||
    typeof raw[1] !== "number" ||
    !Number.isFinite(raw[0]) ||
    !Number.isFinite(raw[1])
  ) {
    throw new TypeError(`投影产物 ${label} 应为 [number, number]`);
  }
  return [raw[0], raw[1]];
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

/**
 * 从子进程输出里取失败真因（`projectViews` 的两条失败路径共用）。
 *
 * 顺序：脚本自写的标记行（`CAD_ERROR_MARKER`）→ stderr 尾部 → stdout 尾部。
 * **不能只看退出码**：实测 freecadcmd 对未捕获的 Python 异常**退出码为 0**，真因只在 stderr
 * ⇒ 输出不可解析时同样要走这里，否则用户拿到的是一句与真因无关的「缺少定界标记」。
 */
export function describeCadFailure(stdout: string, stderr: string): string {
  const nonEmptyLines = (text: string) =>
    text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0);
  const marked = nonEmptyLines(stderr)
    .filter(line => line.startsWith(CAD_ERROR_MARKER))
    .pop();
  if (marked !== undefined) return marked;
  const stderrTail = nonEmptyLines(stderr).slice(-6).join(" | ");
  if (stderrTail.length > 0) return stderrTail;
  const stdoutTail = nonEmptyLines(stdout).slice(-6).join(" | ");
  return stdoutTail.length > 0 ? `stderr 为空；stdout 尾部：${stdoutTail}` : "子进程无任何输出";
}

export type ProjectViewsOptions = {
  /** freecadcmd 路径（由 `resolveFreecadCmd` 得到）。 */
  cmd: string;
  stepPath: string;
  /** 请求的视图（顺序即输出顺序；第一个是主视图）。 */
  views: readonly CadView[];
  /** 剖切（只作用于主视图）：见 `ProjectionScriptOptions.sectionOffsetMm`。 */
  sectionOffsetMm?: number;
  toleranceMm?: number;
  /** 显式锚点探针（模型坐标）：脚本按零件真实几何核对归属。 */
  anchorProbes?: readonly (readonly [number, number, number])[];
  timeoutMs?: number;
  /** 注入点：单测传假运行器（不真跑 FreeCAD）。 */
  runner?: CadRunner;
};

/**
 * 跑**一次**无头投影，产出全部请求视图 + 每零件几何事实 + 锚点归属。
 *
 * 脚本经**临时文件**交付：`freecadcmd` 的位置参数才是"要执行的脚本"，而 `-c` 是
 * "console 模式"开关（**不是** `python -c`）——把脚本内容当参数传会被当作文件名。
 * 临时目录随调用清理（含失败路径）。
 *
 * 两条失败路径（退出码非 0 / 输出不可解析）都经 `describeCadFailure` 带出真因——
 * **不得**以退出码为 0 判定成功（文件头注 6）。
 */
export async function projectViews(options: ProjectViewsOptions): Promise<CadProjectionPayload> {
  const runner = options.runner ?? defaultCadRunner;
  if (options.views.length === 0) {
    throw new TypeError("投影视图集为空：至少要一个视图");
  }
  const primary = options.views[0]!;
  if (options.sectionOffsetMm !== undefined && !isCadSectionView(primary)) {
    throw new TypeError(`视图 ${primary} 不能剖切（剖切要求轴对齐视图）`);
  }
  const script = buildProjectionScript({
    stepPath: options.stepPath,
    views: options.views,
    ...(options.sectionOffsetMm === undefined ? {} : { sectionOffsetMm: options.sectionOffsetMm }),
    ...(options.toleranceMm === undefined ? {} : { toleranceMm: options.toleranceMm }),
    ...(options.anchorProbes === undefined ? {} : { anchorProbes: options.anchorProbes }),
  });
  const dir = await mkdtemp(join(tmpdir(), "sati-cad-"));
  const scriptPath = join(dir, "project.py");
  try {
    await writeFile(scriptPath, script, "utf8");
    const { stdout, stderr, code } = await runner(options.cmd, [scriptPath], {
      timeoutMs: options.timeoutMs ?? CAD_DEFAULT_TIMEOUT_MS,
    });
    if (code !== 0) {
      throw new Error(`freecadcmd 投影失败（退出码 ${String(code)}）：${describeCadFailure(stdout, stderr)}`);
    }
    let payload: CadProjectionPayload;
    try {
      payload = parseProjectionPayload(stdout);
    } catch (err) {
      // 退出码 0 **不是**成功的充分条件：实测 freecadcmd 对未捕获的 Python 异常退出码为 0，
      // 真因只在 stderr ⇒ 解析失败必须把两侧输出一并带出（见 `describeCadFailure`）。
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `freecadcmd 投影失败（退出码 0，输出不可解析：${reason}）：${describeCadFailure(stdout, stderr)}`,
      );
    }
    for (const table of payload.views) {
      if (table.edges.length > CAD_MAX_EDGES) {
        throw new Error(
          `视图 ${table.view} 的投影边数 ${table.edges.length} 超过上限 ${CAD_MAX_EDGES}——请改用更小的装配或分次投影`,
        );
      }
    }
    return payload;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type ProjectStepOptions = Omit<ProjectViewsOptions, "views" | "anchorProbes"> & {
  /** 单视图（既有调用方的入口；内部走 `projectViews` 的单视图路径）。 */
  view: CadView;
};

/**
 * 跑一次无头投影，返回**主视图**的边表（失败 fail-closed：绝不静默回退到别的渲染器）。
 *
 * 单视图路径的薄封装：真正干活的是 `projectViews`（多视图同一条实现），
 * 避免"单视图一套、多视图一套"两套投影口径各自漂移。
 */
export async function projectStep(options: ProjectStepOptions): Promise<CadEdgeTable> {
  const payload = await projectViews({
    ...options,
    views: [options.view],
  });
  const primary = payload.views[0];
  if (primary === undefined) {
    throw new Error("投影产物没有任何视图");
  }
  return primary;
}
