/**
 * scripts/figure-benchmark/gen-render-baseline.ts — 附图渲染产物的**不变式**基线护栏。
 *
 * ## 为什么要有它
 *
 * 仓库既有的「逐字节确定性」断言全是**同一进程内两次调用**比较
 * （`docs/research/patent-figure-dsh-alignment-2026-10.md` §4 第 4 条）⇒ 只能抓随机/时钟/
 * Map 迭代序这类回归，**抓不到跨 graphviz 版本或跨平台的布局漂移**；而决策记录自己承认
 * 「跨 graphviz 版本布局可能有差异」。「有确定性测试」≠「有跨版本漂移护栏」。
 *
 * 本脚本把渲染输出固化成**不含坐标**的不变式基线（入库产物），并提供比对门禁：
 * 渲染布局漂了 ⇒ 变红并指出**哪一幅、哪个量**；基线不存在 ⇒ 报错（不是静默通过）。
 *
 * ## 抽哪些量（都是不变式，不含坐标）
 *
 * - 图号：根元素 `data-figure-no`（机器契约）与可见图号标注（"图N" / "Fig. N" / "FIG. N"）；
 * - `data-ref` 集合（排序去重）；
 * - 纸面尺寸（毫米，**容差** ±{@link PAPER_SIZE_TOLERANCE_MM}mm）；
 * - 文字元素数与文字内容集合（排序去重）；
 * - 图元类别分布（矩形/圆/椭圆/多边形/折线/路径/直线/文字的计数）；
 * - 端点数与线段数——**沿用本仓 `render-check-scan` / `render-check-geometry` 的统计口径**
 *   （不另写一套几何扫描器）；本脚本自己算的只有「元素标签普查」这一项**不含几何**的浅统计，
 *   因为扫描层不暴露元素标签，而「图元类别分布」必须按标签计数。
 *
 * ## 三后端、三套基线（布局不同 ⇒ 基线不能混在一处比）
 *
 * - `builtin`：自研渲染器，零外部依赖、**逐字节确定** ⇒ 额外记录产物内容的 sha256
 *   （逐字节漂移必须变红）；
 * - `graphviz`：系统 `dot` CLI，坐标随 dot 版本漂移 ⇒ 只比不变式；
 * - `graphviz-wasm`：`@viz-js/viz`，与系统 dot 是**两套独立引擎**（实测同用例画幅不同），
 *   基线各自独立。
 *
 * ## 跨版本 / 跨平台口径（写进基线文件本身，否则读者无法判断"红"是不是缺陷）
 *
 * - **结构量**（图号、`data-ref`、文字数与文字内容集合、图元类别分布、图元数）：
 *   与引擎版本无关，任何环境都精确比对——结构漂了就是缺陷；
 * - **坐标派生量**（纸面尺寸、端点数、线段数）：只在本机引擎版本与基线记录**一致**时判定；
 *   版本不同 ⇒ 标注「本环境未核验」，**这不是通过**（AGENTS 第 11 条：降级但不静默）；
 * - 某后端在本机根本不可用（如没有 dot）⇒ 该后端整体标注「本环境未核验」，同样不算通过。
 *
 * ## 用法
 *
 * ```bash
 * tsx scripts/figure-benchmark/gen-render-baseline.ts                    # 与基线比对，漂移即非零退出
 * tsx scripts/figure-benchmark/gen-render-baseline.ts --update           # 重写基线（输出说明哪些量变了）
 * tsx scripts/figure-benchmark/gen-render-baseline.ts --backend=builtin   # 只跑一个后端
 * ```
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createWasmDotRunner,
  renderFigureSvg,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
} from "../../src/patent/figuregen/index.js";
import { subpathSegments } from "../../src/patent/figuregen/render-check-geometry.js";
import { scanSvg } from "../../src/patent/figuregen/render-check-scan.js";
import { parseFigureSvg } from "../../src/patent/figuregen/readback.js";
import { GENERATION_BENCHMARK_CASES, type GenBenchmarkCase } from "./gen-cases.js";

const execFileAsync = promisify(execFile);

/** 基线文件（入库；改动即须在 PR 内说明理由）。 */
export const RENDER_BASELINE_RELATIVE_PATH = "tests/fixtures/patent/figuregen-bench/render-baseline.json";

/** 渲染后端标识。 */
export type RenderBackend = "builtin" | "graphviz" | "graphviz-wasm";

/** 全部后端（基线里按后端分段存，互不混比）。 */
export const RENDER_BACKENDS: readonly RenderBackend[] = ["builtin", "graphviz", "graphviz-wasm"];

/**
 * 纸面尺寸容差（毫米）。
 *
 * 同一引擎版本下纸面尺寸是确定的（逐字节确定的内置渲染器更是如此），容差只用来吸收
 * 字体度量/换算的亚毫米级抖动；**超出容差即判漂移**，不放宽。
 */
export const PAPER_SIZE_TOLERANCE_MM = 0.5;

/**
 * 结构量：与渲染引擎版本无关，任何环境都精确比对。
 *
 * 结构漂了（少了图号、丢了 `data-ref`、文案变了、图元类别分布变了）就是缺陷——
 * 无论在哪台机器、哪个引擎版本上。
 */
export const STRUCTURAL_FIELDS = [
  "figure_no",
  "visible_figure_no",
  "refs",
  "text_count",
  "text_contents",
  "shape_kinds",
  "shape_count",
] as const;

/**
 * 坐标派生量：随布局坐标变化，只在**引擎版本与基线一致**时判定。
 *
 * dot 版本升级会让画幅与连线路由变化（那是布局漂移，不是缺陷）；引擎版本一致时
 * 这些量必须逐项相同，否则就是本仓代码改动引起的渲染漂移。
 */
export const GEOMETRY_FIELDS = ["width_mm", "height_mm", "endpoint_count", "segment_count"] as const;

/** 单幅附图的不变式（**不含坐标**）。 */
export type FigureRenderInvariant = {
  /** 根元素 `data-figure-no` 回读的图号。 */
  figure_no: number;
  /** 可见图号标注原文（"图1" / "Fig. 1" / "FIG. 1"）；无可见图号时为 null。 */
  visible_figure_no: string | null;
  /** `data-ref` 集合（排序去重）。 */
  refs: number[];
  /** 纸面宽（毫米）。 */
  width_mm: number;
  /** 纸面高（毫米）。 */
  height_mm: number;
  /** 文字元素数。 */
  text_count: number;
  /** 文字内容集合（排序去重）。 */
  text_contents: string[];
  /** 图元类别分布（元素标签 → 个数）。 */
  shape_kinds: Record<string, number>;
  /** 图元总数（扫描层的图形元素数；文字另计）。 */
  shape_count: number;
  /** 端点数（扫描层统计口径：所有子路径顶点总数）。 */
  endpoint_count: number;
  /** 线段数（扫描层统计口径：所有子路径展开的线段总数）。 */
  segment_count: number;
  /** 产物内容的 sha256（仅内置渲染器记录：它逐字节确定）。 */
  content_sha256: string | null;
};

/** 单个用例（可含多幅）的逐幅不变式。 */
export type CaseRenderInvariant = {
  /** 用例 id（与 `gen-cases.ts` 同源）。 */
  id: string;
  /** 逐幅不变式。 */
  figures: FigureRenderInvariant[];
};

/** 单个后端的基线段。 */
export type BackendBaseline = {
  /** 后端标识。 */
  backend: RenderBackend;
  /**
   * 引擎版本标识。
   *
   * `builtin` 恒为 `"builtin"`；`graphviz` 为系统 dot 的版本号；`graphviz-wasm` 为
   * `@viz-js/viz` 的包版本。它是**坐标派生量的判定前提**：版本不同则那些量不判定。
   */
  engine_version: string;
  /** 逐用例不变式。 */
  cases: CaseRenderInvariant[];
};

/** 基线里记录的容差与判定口径（写进产物，读者据此判断"红"是不是缺陷）。 */
export type RenderBaselinePolicy = {
  /** 纸面尺寸容差（毫米）。 */
  paper_size_tolerance_mm: number;
  /** 精确比对的结构量。 */
  structural_fields: readonly string[];
  /** 仅在引擎版本一致时比对的坐标派生量。 */
  geometry_fields: readonly string[];
  /** 逐字节比对的量（仅内置渲染器有）。 */
  byte_exact_fields: readonly string[];
  /** 口径说明（中文，随基线一起入库）。 */
  notes: string;
};

/** 整份基线。 */
export type RenderBaseline = {
  /** 生成方式（可复算入口）。 */
  generator: string;
  /** 输入集来源。 */
  input_cases: string;
  /** 容差与判定口径。 */
  policy: RenderBaselinePolicy;
  /** 逐后端基线段。 */
  backends: Partial<Record<RenderBackend, BackendBaseline>>;
};

/** 漂移条目。 */
export type DriftEntry = {
  /** 漂移位置（例：`builtin/flow-tb-8/图1/text_contents[2]`）。 */
  path: string;
  /** 量的名字。 */
  field: string;
  /** 基线取值（可读形式）。 */
  expected: string;
  /** 实际取值（可读形式）。 */
  actual: string;
  /** 漂移类别。 */
  kind: "exact" | "tolerance" | "missing" | "extra";
};

/** 单个后端的比对结论。 */
export type BackendComparison = {
  /** 后端标识。 */
  backend: RenderBackend;
  /** 本环境是否渲染了该后端（渲染失败/缺依赖即 false）。 */
  rendered: boolean;
  /** 引擎版本是否与基线一致（决定坐标派生量是否判定）。 */
  engine_matched: boolean;
  /** 漂移清单。 */
  drifts: DriftEntry[];
  /** 未核验的量（引擎版本不同 ⇒ 坐标派生量不判定）。 */
  unverified: string[];
  /** 结论说明（中文）。 */
  note: string;
};

/** 整份基线的比对结论。 */
export type RenderBaselineComparison = {
  /** 全部漂移。 */
  drifts: DriftEntry[];
  /** 逐后端结论。 */
  backends: BackendComparison[];
};

// ---------------------------------------------------------------- 元素标签普查

/** 参与「图元类别分布」统计的元素标签（容器与结构标签不计）。 */
const CENSUS_TAGS = new Set(["rect", "circle", "ellipse", "polygon", "polyline", "path", "line", "text"]);

/**
 * 定义容器：其子元素只被引用而不直接渲染，整段跳过。
 *
 * 与 `render-check-scan.ts` 的同名清单同源（那里是几何扫描的跳过规则；这里是标签普查的
 * 跳过规则）——目的相同：不把 `<defs><marker><path>` 这类不画到纸面上的墨迹算成图元。
 */
const SKIP_CONTAINERS = new Set([
  "defs",
  "clippath",
  "mask",
  "marker",
  "pattern",
  "symbol",
  "filter",
  "lineargradient",
  "radialgradient",
  "style",
]);

/**
 * 元素标签普查：数各类图元各画了几个。
 *
 * **浅统计，不含几何**：只按标签计数，跳过定义容器里的内容。仓库的扫描层
 * （`render-check-scan`）不暴露元素标签，而「图元类别分布」必须按标签计数，
 * 故此处单独做一次标签普查——几何量（端点/线段/画幅）一律取扫描层的口径，不另写扫描器。
 * @param svg - 完整 SVG 文本。
 * @returns 标签 → 个数（只含出现过的标签，按标签名排序）。
 */
export function censusShapeKinds(svg: string): Record<string, number> {
  const counts = new Map<string, number>();
  let skipDepth = 0;
  const tagPattern = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|[^>])*?)(\/?)>/g;
  for (const match of svg.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const selfClosing = match[4] === "/";
    if (skipDepth > 0) {
      if (!closing && !selfClosing) skipDepth += 1;
      else if (closing) skipDepth -= 1;
      continue;
    }
    if (closing) continue;
    if (selfClosing) {
      if (CENSUS_TAGS.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      continue;
    }
    if (SKIP_CONTAINERS.has(tag)) {
      skipDepth = 1;
      continue;
    }
    if (CENSUS_TAGS.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const result: Record<string, number> = {};
  for (const tag of [...counts.keys()].sort()) result[tag] = counts.get(tag)!;
  return result;
}

// ---------------------------------------------------------------- 不变式抽取

/** 可见图号标注的形态（与 `readback.ts` 的回读口径同源：图号在图尾的标注文本）。 */
const CAPTION_PATTERN = /^(?:图|Fig\.|FIG\.)\s*\d+$/u;

/** 数值保留位数（毫米量；三位足够分辨亚毫米抖动，又不会把浮点噪声写进基线）。 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 从一幅已渲染的 SVG 抽取不变式。
 *
 * 纯函数：同一段 SVG 文本 ⇒ 同一份不变式（无时钟/随机/Map 迭代序依赖）。
 * @param svg - 完整 SVG 文本（内置渲染器或 graphviz 产物）。
 * @param options - `backend` 决定是否记录逐字节指纹（只有内置渲染器逐字节确定）。
 * @returns 单幅不变式。
 */
export function extractFigureInvariant(svg: string, options: { backend: RenderBackend }): FigureRenderInvariant {
  const scan = scanSvg(svg);
  const parsed = parseFigureSvg(svg);
  const captions = scan.texts.map(text => text.content).filter(content => CAPTION_PATTERN.test(content));
  const refs = [...new Set(parsed.nodes.flatMap(node => (node.ref === undefined ? [] : [node.ref])))].sort(
    (a, b) => a - b,
  );
  const textContents = [...new Set(scan.texts.map(text => text.content))].sort();

  let endpointCount = 0;
  let segmentCount = 0;
  for (const shape of scan.shapes) {
    for (const subpath of shape.subpaths) {
      endpointCount += subpath.points.length;
      segmentCount += subpathSegments(subpath).length;
    }
  }

  return {
    figure_no: parsed.figureNo,
    visible_figure_no: captions.length === 0 ? null : captions[captions.length - 1]!,
    refs,
    width_mm: round(scan.widthMm ?? 0, 3),
    height_mm: round(scan.heightMm ?? 0, 3),
    text_count: scan.texts.length,
    text_contents: textContents,
    shape_kinds: censusShapeKinds(svg),
    shape_count: scan.shapes.length,
    endpoint_count: endpointCount,
    segment_count: segmentCount,
    content_sha256: options.backend === "builtin" ? createHash("sha256").update(svg, "utf8").digest("hex") : null,
  };
}

// ---------------------------------------------------------------- 渲染与采集

/** 引擎版本标识：内置渲染器恒定。 */
const BUILTIN_ENGINE_VERSION = "builtin";

/** 仓库根目录（由本文件位置推导，与调用时的 cwd 无关）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 读取系统 dot 的版本号（`dot -V` 打到 stderr）；读不到时返回 "unknown"。 */
async function readDotVersion(dotPath: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync(dotPath, ["-V"], { timeout: 15_000 });
    const match = /version\s+(\d+(?:\.\d+)*)/iu.exec(stderr);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 读取 `@viz-js/viz` 的包版本（WASM 后端的引擎标识）；读不到时返回 "unknown"。 */
async function readVizVersion(): Promise<string> {
  try {
    const raw = await readFile(path.join(REPO_ROOT, "node_modules/@viz-js/viz/package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** 后端可用性：可用则给引擎版本，不可用则给中文原因。 */
export type BackendAvailability = { available: true; engineVersion: string } | { available: false; reason: string };

/**
 * 探测某后端在本机是否可用，以及它的引擎版本。
 *
 * 「不可用」是**如实降级**而不是通过：调用方必须把它标成「本环境未核验」。
 * @param backend - 后端标识。
 * @returns 可用性与引擎版本。
 */
export async function probeBackend(backend: RenderBackend): Promise<BackendAvailability> {
  if (backend === "builtin") return { available: true, engineVersion: BUILTIN_ENGINE_VERSION };
  if (backend === "graphviz") {
    const dotPath = resolveDotBinary();
    if (dotPath === null) {
      return { available: false, reason: "本环境未找到 graphviz dot 可执行文件（未安装 graphviz 或不在 PATH 上）" };
    }
    return { available: true, engineVersion: await readDotVersion(dotPath) };
  }
  try {
    const runner = createWasmDotRunner();
    await runner("digraph { a -> b }");
    return { available: true, engineVersion: await readVizVersion() };
  } catch (error) {
    return {
      available: false,
      reason: `WASM 版 graphviz 不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 渲染一幅附图（三个后端各自走本仓既有的渲染通路）。
 * @param backend - 后端标识。
 * @param spec - 附图结构。
 * @param options - 法域与本案附图总幅数（图号是否标注的输入）。
 * @returns SVG 文本。
 */
async function renderOne(
  backend: RenderBackend,
  spec: GenBenchmarkCase["figures"][number],
  options: { jurisdiction?: GenBenchmarkCase["jurisdiction"]; figureCount: number },
): Promise<string> {
  if (backend === "builtin") {
    return renderFigureSvg(spec, {
      ...(options.jurisdiction === undefined ? {} : { jurisdiction: options.jurisdiction }),
      figureCount: options.figureCount,
    }).svg;
  }
  const runner = backend === "graphviz-wasm" ? createWasmDotRunner() : undefined;
  const rendered = await renderFigureSvgWithGraphviz(spec, {
    ...(runner === undefined ? {} : { runner }),
    ...(options.jurisdiction === undefined ? {} : { jurisdiction: options.jurisdiction }),
    figureCount: options.figureCount,
  });
  return rendered.svg;
}

/**
 * 采集一个后端的整份基线段。
 * @param backend - 后端标识。
 * @param cases - 输入用例集（缺省取 `gen-cases.ts` 的固定集合）。
 * @returns 基线段；后端不可用时抛出（调用方应先 `probeBackend`）。
 */
export async function collectBackendBaseline(
  backend: RenderBackend,
  cases: readonly GenBenchmarkCase[] = GENERATION_BENCHMARK_CASES,
  availability?: BackendAvailability,
): Promise<BackendBaseline> {
  const probe = availability ?? (await probeBackend(backend));
  if (!probe.available) throw new Error(probe.reason);
  const caseInvariants: CaseRenderInvariant[] = [];
  for (const benchmarkCase of cases) {
    const figureCount = benchmarkCase.figureCount ?? benchmarkCase.figures.length;
    const figures: FigureRenderInvariant[] = [];
    for (const spec of benchmarkCase.figures) {
      const svg = await renderOne(backend, spec, {
        ...(benchmarkCase.jurisdiction === undefined ? {} : { jurisdiction: benchmarkCase.jurisdiction }),
        figureCount,
      });
      figures.push(extractFigureInvariant(svg, { backend }));
    }
    caseInvariants.push({ id: benchmarkCase.id, figures });
  }
  return { backend, engine_version: probe.engineVersion, cases: caseInvariants };
}

/** 基线的容差与判定口径（写进产物，读者据此判断"红"是不是缺陷）。 */
export function renderBaselinePolicy(): RenderBaselinePolicy {
  return {
    paper_size_tolerance_mm: PAPER_SIZE_TOLERANCE_MM,
    structural_fields: [...STRUCTURAL_FIELDS],
    geometry_fields: [...GEOMETRY_FIELDS],
    byte_exact_fields: ["content_sha256"],
    notes:
      "结构量（图号/data-ref/文字数/文字内容集合/图元类别分布/图元数）与引擎版本无关，任何环境都精确比对；" +
      "坐标派生量（纸面尺寸/端点数/线段数）只在**引擎版本与本基线记录一致**时判定——dot 版本升级导致的" +
      "布局漂移不是缺陷，届时这些量标注「本环境未核验」（无信号，不是通过）。" +
      "纸面尺寸按 ±0.5mm 容差比较；内置渲染器逐字节确定，额外比对产物内容的 sha256。",
  };
}

/**
 * 采集整份基线（逐后端；不可用的后端不入基线，由调用方标注「本环境未核验」）。
 * @param cases - 输入用例集。
 * @returns 基线对象。
 */
export async function collectRenderBaseline(
  cases: readonly GenBenchmarkCase[] = GENERATION_BENCHMARK_CASES,
): Promise<RenderBaseline> {
  const backends: Partial<Record<RenderBackend, BackendBaseline>> = {};
  for (const backend of RENDER_BACKENDS) {
    const availability = await probeBackend(backend);
    if (!availability.available) continue;
    backends[backend] = await collectBackendBaseline(backend, cases, availability);
  }
  return {
    generator: "scripts/figure-benchmark/gen-render-baseline.ts",
    input_cases: "scripts/figure-benchmark/gen-cases.ts",
    policy: renderBaselinePolicy(),
    backends,
  };
}

// ---------------------------------------------------------------- 比对

/** 可读化：把取值转成一行可读文本（供漂移说明使用）。 */
function readable(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 逐项比对两个取值（精确口径），产出带路径的漂移清单。
 *
 * 不直接 deepEqual 是为了让失败信息指出**哪一项**漂了（`…/图1/text_contents[2]: "甲" → "乙"`）。
 * @param expected - 基线取值。
 * @param actual - 实际取值。
 * @param path - 当前路径前缀。
 * @param drifts - 漂移清单（原地追加）。
 */
function compareExact(expected: unknown, actual: unknown, path: string, drifts: DriftEntry[]): void {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      drifts.push({
        path: `${path}.length`,
        field: "length",
        expected: String(expected.length),
        actual: String(actual.length),
        kind: "exact",
      });
      return;
    }
    expected.forEach((item, index) => compareExact(item, actual[index], `${path}[${index}]`, drifts));
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) compareExact(expected[key], actual[key], `${path}.${key}`, drifts);
    return;
  }
  if (expected === actual) return;
  drifts.push({
    path,
    field: path.split(".").pop() ?? path,
    expected: readable(expected),
    actual: readable(actual),
    kind: "exact",
  });
}

/**
 * 比对单幅不变式。
 * @param expected - 基线取值。
 * @param actual - 实际取值。
 * @param basePath - 路径前缀（`后端/用例/图N`）。
 * @param engineMatched - 引擎版本是否一致（决定坐标派生量是否判定）。
 * @param drifts - 漂移清单（原地追加）。
 * @param unverified - 未核验量清单（原地追加）。
 */
function compareFigure(
  expected: FigureRenderInvariant,
  actual: FigureRenderInvariant,
  basePath: string,
  engineMatched: boolean,
  drifts: DriftEntry[],
  unverified: string[],
): void {
  for (const field of STRUCTURAL_FIELDS) {
    compareExact(expected[field], actual[field], `${basePath}.${field}`, drifts);
  }
  if (!engineMatched) {
    for (const field of GEOMETRY_FIELDS) unverified.push(`${basePath}.${field}`);
    return;
  }
  for (const field of ["width_mm", "height_mm"] as const) {
    const difference = Math.abs(expected[field] - actual[field]);
    if (difference > PAPER_SIZE_TOLERANCE_MM) {
      drifts.push({
        path: `${basePath}.${field}`,
        field,
        expected: `${expected[field]}mm`,
        actual: `${actual[field]}mm`,
        kind: "tolerance",
      });
    }
  }
  for (const field of ["endpoint_count", "segment_count"] as const) {
    compareExact(expected[field], actual[field], `${basePath}.${field}`, drifts);
  }
  if (expected.content_sha256 !== null || actual.content_sha256 !== null) {
    compareExact(expected.content_sha256, actual.content_sha256, `${basePath}.content_sha256`, drifts);
  }
}

/**
 * 比对单个后端的基线段。
 * @param expected - 基线段。
 * @param actual - 实际采集到的基线段。
 * @returns 该后端的比对结论。
 */
export function compareBackendBaseline(expected: BackendBaseline, actual: BackendBaseline): BackendComparison {
  const engineMatched = expected.engine_version === actual.engine_version;
  const drifts: DriftEntry[] = [];
  const unverified: string[] = [];
  const actualCases = new Map(actual.cases.map(item => [item.id, item]));
  for (const expectedCase of expected.cases) {
    const actualCase = actualCases.get(expectedCase.id);
    if (actualCase === undefined) {
      drifts.push({
        path: `${actual.backend}/${expectedCase.id}`,
        field: "case",
        expected: expectedCase.id,
        actual: "(缺失)",
        kind: "missing",
      });
      continue;
    }
    const actualFigures = new Map(actualCase.figures.map(item => [item.figure_no, item]));
    for (const expectedFigure of expectedCase.figures) {
      const actualFigure = actualFigures.get(expectedFigure.figure_no);
      const basePath = `${actual.backend}/${expectedCase.id}/图${expectedFigure.figure_no}`;
      if (actualFigure === undefined) {
        drifts.push({
          path: basePath,
          field: "figure",
          expected: `图${expectedFigure.figure_no}`,
          actual: "(缺失)",
          kind: "missing",
        });
        continue;
      }
      compareFigure(expectedFigure, actualFigure, basePath, engineMatched, drifts, unverified);
    }
  }
  const expectedCaseIds = new Set(expected.cases.map(item => item.id));
  for (const actualCase of actual.cases) {
    if (expectedCaseIds.has(actualCase.id)) continue;
    drifts.push({
      path: `${actual.backend}/${actualCase.id}`,
      field: "case",
      expected: "(无)",
      actual: actualCase.id,
      kind: "extra",
    });
  }
  return {
    backend: actual.backend,
    rendered: true,
    engine_matched: engineMatched,
    drifts,
    unverified,
    note: engineMatched
      ? `已核验（引擎 ${actual.engine_version}，与基线一致）`
      : `部分核验：引擎版本与基线不同（基线 ${expected.engine_version} / 本机 ${actual.engine_version}）` +
        "⇒ 坐标派生量（纸面尺寸/端点数/线段数）本环境未核验，结构量仍已比对",
  };
}

// ---------------------------------------------------------------- 基线读写

/** 基线路径（相对仓库根；测试与 CLI 共用）。 */
export function renderBaselinePath(cwd: string): string {
  return path.resolve(cwd, RENDER_BASELINE_RELATIVE_PATH);
}

/**
 * 解析基线 JSON（结构不合法即 fail-loud，不静默当作"无基线"）。
 * @param text - 基线文件原文。
 * @returns 基线对象。
 */
export function parseRenderBaseline(text: string): RenderBaseline {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.backends) || !isPlainObject(parsed.policy)) {
    throw new Error("基线缺少 backends/policy 字段（用 --update 重新生成）");
  }
  return parsed as unknown as RenderBaseline;
}

/**
 * 读取基线文件；**缺失或损坏都抛错**（不得静默当作"无基线 ⇒ 通过"）。
 * @param target - 基线文件路径。
 * @returns 基线对象。
 */
export async function loadRenderBaseline(target: string): Promise<RenderBaseline> {
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    throw new Error(`基线缺失: ${target}（用 --update 生成）`);
  }
  try {
    return parseRenderBaseline(raw);
  } catch (error) {
    throw new Error(`基线不可解析: ${target}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** 写基线文件（稳定缩进 + 末尾换行，保证同一输入 ⇒ 同一字节）。 */
export async function writeRenderBaseline(target: string, baseline: RenderBaseline): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------- CLI

/** 逐后端比对结论的可读行。 */
function formatBackendStatus(comparison: BackendComparison): string {
  if (!comparison.rendered) {
    return `  ${comparison.backend.padEnd(14)} ${comparison.note}｜未比对`;
  }
  if (comparison.drifts.length > 0) {
    return `  ${comparison.backend.padEnd(14)} ${comparison.note}｜漂移 ${comparison.drifts.length} 处`;
  }
  if (comparison.unverified.length > 0) {
    return `  ${comparison.backend.padEnd(14)} ${comparison.note}｜结构量一致，${comparison.unverified.length} 个坐标派生量未核验`;
  }
  return `  ${comparison.backend.padEnd(14)} ${comparison.note}｜与基线一致`;
}

/** 打印漂移清单（指出哪一幅、哪个量）。 */
function printDrifts(drifts: readonly DriftEntry[]): void {
  console.error(`渲染不变式漂移 ${drifts.length} 处（基线 → 实际）：`);
  for (const drift of drifts.slice(0, 30)) {
    const kind = drift.kind === "tolerance" ? `（容差 ±${PAPER_SIZE_TOLERANCE_MM}mm）` : "";
    console.error(`  - ${drift.path}: ${drift.expected} → ${drift.actual}${kind}`);
  }
  if (drifts.length > 30) console.error(`  …其余 ${drifts.length - 30} 处`);
}

/** 解析命令行参数。 */
function parseArgs(argv: readonly string[]): { update: boolean; backends: readonly RenderBackend[] } {
  const update = argv.includes("--update");
  const backendArg = argv.find(arg => arg.startsWith("--backend="))?.slice("--backend=".length);
  if (backendArg === undefined) return { update, backends: RENDER_BACKENDS };
  if (!RENDER_BACKENDS.includes(backendArg as RenderBackend)) {
    throw new Error(`未知后端 "${backendArg}"（可选：${RENDER_BACKENDS.join(" / ")}）`);
  }
  return { update, backends: [backendArg as RenderBackend] };
}

async function main(): Promise<void> {
  const { update, backends } = parseArgs(process.argv.slice(2));
  const target = renderBaselinePath(process.cwd());
  const collected = await collectRenderBaseline();

  if (update) {
    let previous: RenderBaseline | undefined;
    try {
      previous = await loadRenderBaseline(target);
    } catch {
      previous = undefined;
    }
    const merged: RenderBaseline = {
      generator: collected.generator,
      input_cases: collected.input_cases,
      policy: collected.policy,
      backends: { ...(previous?.backends ?? {}), ...collected.backends },
    };
    for (const backend of backends) {
      const next = collected.backends[backend];
      if (next === undefined) {
        console.log(`后端 ${backend}：本环境不可用，未写入基线（该后端在本环境未核验）`);
        continue;
      }
      const before = previous?.backends[backend];
      if (before === undefined) {
        console.log(`后端 ${backend}：基线新增（引擎 ${next.engine_version}）`);
        continue;
      }
      const comparison = compareBackendBaseline(before, next);
      console.log(`后端 ${backend}：引擎 ${before.engine_version} → ${next.engine_version}`);
      if (comparison.drifts.length > 0) printDrifts(comparison.drifts);
      if (comparison.unverified.length > 0) {
        console.log(
          `  ${comparison.unverified.length} 个坐标派生量（纸面尺寸/端点数/线段数）因引擎版本变化` +
            "未与旧基线比对，已按新引擎重新记录",
        );
      }
      if (comparison.drifts.length === 0 && comparison.unverified.length === 0) {
        console.log("  没有任何量发生变化");
      }
    }
    await writeRenderBaseline(target, merged);
    console.log(`基线已更新: ${target}`);
    return;
  }

  const baseline = await loadRenderBaseline(target);
  const drifts: DriftEntry[] = [];
  const comparisons: BackendComparison[] = [];
  for (const backend of backends) {
    const actual = collected.backends[backend];
    const expected = baseline.backends[backend];
    if (actual === undefined) {
      const availability = await probeBackend(backend);
      comparisons.push({
        backend,
        rendered: false,
        engine_matched: false,
        drifts: [],
        unverified: [],
        note: `未核验：${availability.available ? "本环境未采集该后端" : availability.reason}——这是无信号，不是通过`,
      });
      continue;
    }
    if (expected === undefined) {
      const missing: DriftEntry = {
        path: backend,
        field: "baseline",
        expected: "(基线缺少该后端产物)",
        actual: backend,
        kind: "missing",
      };
      drifts.push(missing);
      comparisons.push({
        backend,
        rendered: true,
        engine_matched: false,
        drifts: [missing],
        unverified: [],
        note: "基线缺少该后端产物（本环境可渲染）",
      });
      continue;
    }
    const comparison = compareBackendBaseline(expected, actual);
    comparisons.push(comparison);
    drifts.push(...comparison.drifts);
  }

  for (const comparison of comparisons) console.log(formatBackendStatus(comparison));
  const unverifiedBackends = comparisons.filter(item => !item.rendered);
  const partialBackends = comparisons.filter(item => item.rendered && item.unverified.length > 0);
  if (unverifiedBackends.length > 0) {
    console.log(
      `注意：${unverifiedBackends.map(item => item.backend).join(" / ")} 在本环境未核验（缺依赖或后端不可用）——` +
        "这不是通过，别把它当成绿灯。",
    );
  }
  if (partialBackends.length > 0) {
    console.log(
      `注意：${partialBackends.map(item => item.backend).join(" / ")} 的坐标派生量（纸面尺寸/端点数/线段数）` +
        "因引擎版本与基线不同而未核验——这部分无信号，不是通过。",
    );
  }
  if (drifts.length > 0) {
    printDrifts(drifts);
    console.error("确认变更符合预期后用 --update 刷新基线，并在 PR 中说明理由。");
    process.exitCode = 1;
    return;
  }
  const verified = comparisons.filter(item => item.rendered && item.unverified.length === 0).length;
  console.log(
    verified === comparisons.length
      ? `附图渲染不变式与基线一致（${verified}/${comparisons.length} 个后端已核验）。`
      : `已核验部分与基线一致（${verified}/${comparisons.length} 个后端完整核验；其余为未核验，不是通过）。`,
  );
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("附图渲染基线运行失败:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
