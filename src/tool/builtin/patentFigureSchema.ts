/**
 * patent_figure_* 工具共享的 FigureSpec JSON Schema 与入参归一化。
 *
 * 单一事实源：patent_figure_generate 与 patent_figure_check 的 figures 入参
 * 使用同一 schema（注意：修改描述文本会使 llm-replay fixture 失配，须重录）。
 *
 * 三个制图工具共享法域字段与图幅/页码字段：**归一化收在这一处**，避免三处各写一遍
 * 收窄逻辑后漂移（一处漏掉 `pct` 就会让同一份图在两个工具里按不同法域判定）。
 */

import { figureEdges, figureNodes, type FigureSpec, type Jurisdiction } from "../../patent/figuregen/index.js";
import { isRefNumeral } from "../../patent/figuregen/numeral.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiJsonSchema } from "../protocol/schema.js";

/** 法域取值（三工具 inputSchema 的 enum 与此同源；运行时收窄见 `toJurisdiction`）。 */
export const JURISDICTIONS: string[] = ["cn", "us", "pct"];

/** 图型取值（schema enum 与 `FigureKind` 同源；同步守卫见 tests/patent/figuregen/tools.spec.ts）。 */
export const FIGURE_KINDS: string[] = [
  "flowchart",
  "block",
  "state",
  "hierarchy",
  "chart",
  "sequence",
  "circuit",
  "cross-section",
];

/** 节点形状取值（schema enum 与 `FigureNodeShape` 同源）。 */
export const FIGURE_NODE_SHAPES: string[] = [
  "rect",
  "round",
  "diamond",
  "ellipse",
  "cylinder",
  "parallelogram",
  "circle",
  "doublecircle",
  "resistor",
  "capacitor",
  "inductor",
  "diode",
  "source",
  "ground",
  "switch",
  "lamp",
  "battery",
];

/** 曲线标记取值（schema enum 与 `ChartMarker` 同源）。 */
export const CHART_MARKERS: string[] = [
  "none",
  "circle",
  "square",
  "triangle",
  "filled-circle",
  "filled-square",
  "filled-triangle",
  "cross",
  "plus",
];

/** 曲线线型取值（schema enum 与 `ChartLineStyle` 同源）。 */
export const CHART_LINE_STYLES: string[] = ["solid", "dashed", "dotted"];

/**
 * 入参 → 法域（未知/缺省一律 cn）。
 * 与 schema 的 enum 收窄同向：schema 挡在调用前，这里是运行时的兜底。
 */
export function toJurisdiction(value: unknown): Jurisdiction {
  return value === "us" ? "us" : value === "pct" ? "pct" : "cn";
}

/** 本案附图总幅数：显式声明优先，缺省取本次调用渲染的幅数（分次生成时调用方须显式声明）。 */
export function toFigureCount(value: unknown, renderedCount: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : renderedCount;
}

/** 附图页序号/总页数（成对声明才算：只给一个无从判断页码体例）。 */
export function toSheet(value: {
  sheet_index?: unknown;
  sheet_total?: unknown;
}): { index: number; total: number } | undefined {
  const total = value.sheet_total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 1) return undefined;
  const index = value.sheet_index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) return undefined;
  return { index, total };
}

/**
 * 单幅附图的结构元素上限（nodes + edges）。
 *
 * 与 deepseek-harness 的 `STRUCTURAL_MAX_ITEMS` 同值（200）：超过它时任何自动布局
 * （分层或 graphviz）都会把图压缩到字高不足，画出来也过不了 V7 的字高判据。在入参处
 * 拒绝比让渲染器出一张"合规但读不出"的图更早、更可操作。
 */
export const STRUCTURAL_MAX_ITEMS = 200;

/**
 * figures 入参的结构性校验（`patent_figure_generate` 与 `patent_figure_check` 共用）。
 *
 * JSON Schema 只挡类型/枚举/未知属性（`src/tool/execution/validateToolInput.ts` 不校验
 * `minItems`/`maxItems`），条数与成对性在这里兜底，避免"空节点图"或"没有数据点的曲线"
 * 静默出一张空图：
 * - 单幅 `nodes + edges` 不超过 {@link STRUCTURAL_MAX_ITEMS}；
 * - 非曲线图：`nodes` 不能为空；
 * - 曲线图（kind=chart）：必须有 `chart` 数据、至少 1 条曲线、每条曲线至少 1 个数据点、
 *   每个数据点是 `[x, y]` 两个有限数，且两根轴都有非空标目。
 */
export function assertFigurePayloads(figures: readonly FigureSpec[], tool: string): void {
  const invalid: (message: string, figureNo?: number) => never = (message, figureNo) => {
    throw new SatiToolRuntimeError("invalid_tool_input", message, {
      tool,
      ...(figureNo === undefined ? {} : { figure_no: figureNo }),
    });
  };
  for (const figure of figures) {
    const no = figure.figure_no;
    // 多面板附图：条数上限按**摊平**口径算（所有面板的节点/边合计），否则每个面板
    // 各自 200 个、四个面板就 800 个 —— 上限就形同虚设。
    const nodeCount = figureNodes(figure).length;
    const edgeCount = figureEdges(figure).length;
    if (nodeCount + edgeCount > STRUCTURAL_MAX_ITEMS) {
      invalid(
        `图${no} 的结构元素共 ${nodeCount + edgeCount} 个（nodes ${nodeCount} + edges ${edgeCount}），` +
          `超过单幅上限 ${STRUCTURAL_MAX_ITEMS}：超过它自动布局会把字压到不可辨（V7 字高判据必然不过），` +
          "请拆分为多幅附图，或把可合并的节点合并为更高层的功能模块",
        no,
      );
    }
    if (Array.isArray(figure.nodes)) {
      for (const node of figure.nodes) {
        if (node.ref !== undefined && !isRefNumeral(node.ref)) {
          invalid(
            `图${no} 节点「${node.id}」的附图标记应为正整数（V22，收到 ${String(node.ref)}）：` +
              "0、负数或小数无法作为可引用的标记",
            no,
          );
        }
      }
    }
    if (figure.section !== undefined) {
      // 剖视输入：断面零件非空、轮廓至少 3 点、坐标在归一化域 0..1。
      if (figure.section.parts.length === 0) {
        invalid(`图${no} 的 section.parts 不能为空（剖视图至少要一个断面零件）`, no);
      }
      for (const part of figure.section.parts) {
        if (part.outline.length < 3) {
          invalid(`图${no} 零件「${part.id}」的断面轮廓至少要 3 个顶点（收到 ${String(part.outline.length)}）`, no);
        }
        for (const [x, y] of part.outline) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            invalid(`图${no} 零件「${part.id}」的轮廓坐标必须是有限数`, no);
          }
          if (x < 0 || x > 1 || y < 0 || y > 1) {
            invalid(`图${no} 零件「${part.id}」的轮廓坐标须落在归一化域 0..1（收到 ${String(x)},${String(y)}）`, no);
          }
        }
        if (part.ref !== undefined && !isRefNumeral(part.ref)) {
          invalid(`图${no} 零件「${part.id}」的附图标记应为正整数（V22，收到 ${String(part.ref)}）`, no);
        }
      }
    }
    if (figure.kind !== "chart") {
      // 多面板附图：内容在面板里（顶层 nodes/edges 被忽略）⇒ 逐面板要求非空，
      // 且面板里的节点同样要过 ref 合法性与条数上限。
      if (figure.panels !== undefined && figure.panels.length > 0) {
        figure.panels.forEach((panel, index) => {
          if (!Array.isArray(panel.nodes) || panel.nodes.length === 0) {
            invalid(`图${no} 的第 ${index + 1} 个面板没有节点（面板不能为空）`, no);
          }
          for (const node of panel.nodes) {
            if (node.ref !== undefined && !isRefNumeral(node.ref)) {
              invalid(
                `图${no} 面板 ${index + 1} 节点「${node.id}」的附图标记应为正整数（V22，收到 ${String(node.ref)}）`,
                no,
              );
            }
          }
        });
        continue;
      }
      if (!Array.isArray(figure.nodes) || figure.nodes.length === 0) {
        // 剖视图的节点在 `section.parts` 里（断面零件）⇒ 顶层 nodes 可为空。
        const hasSectionParts = figure.section !== undefined && figure.section.parts.length > 0;
        if (!hasSectionParts) {
          invalid(`图${no} 的 nodes 不能为空`, no);
        }
      }
      continue;
    }

    const chart = (figure as { chart?: unknown }).chart;
    if (!isRecord(chart)) {
      invalid(`图${no} kind=chart 但缺少 chart 数据（坐标轴与数据序列）`, no);
    }
    const series = chart.series;
    if (!Array.isArray(series) || series.length === 0) {
      invalid(`图${no} 的 chart.series 不能为空（曲线图至少 1 条曲线）`, no);
    }
    series.forEach((entry, index) => {
      const points = isRecord(entry) ? entry.points : undefined;
      if (!Array.isArray(points) || points.length === 0) {
        invalid(`图${no} 第 ${index + 1} 条曲线没有数据点`, no);
      }
      points.forEach((point, pointIndex) => {
        const pair = Array.isArray(point) ? point : [];
        const valid = pair.length === 2 && pair.every(value => typeof value === "number" && Number.isFinite(value));
        if (!valid) {
          invalid(
            `图${no} 第 ${index + 1} 条曲线的第 ${pointIndex + 1} 个数据点不是 [x, y] 两个有限数：${JSON.stringify(point)}`,
            no,
          );
        }
      });
    });
    for (const axis of ["x", "y"] as const) {
      const value = chart[axis];
      if (!isRecord(value) || typeof value.title !== "string" || value.title.trim() === "") {
        invalid(`图${no} 的 ${axis} 轴缺少标目（chart.${axis}.title 必填：读者须知道该轴是什么量，含单位）`, no);
      }
      // 显式两端相等或倒置 ⇒ 零/负跨度轴：坐标映射 `(v − min) / (max − min)` 除零产 NaN，
      // 渲染器丢弃 NaN 元素后**整条曲线从图面上消失**，而核验器的判据对 NaN 恒为 false
      // （"通过"）——无效交付物加核验盖章，错误直达定稿。故在入参处拒绝（模型很容易为
      // 单点数据产出 `{min: 5, max: 5}`，这里给出可操作的替代写法）。
      const min = typeof value?.min === "number" ? value.min : undefined;
      const max = typeof value?.max === "number" ? value.max : undefined;
      if (min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && min >= max) {
        invalid(
          `图${no} 的 ${axis} 轴范围须 min < max（收到 min=${min}、max=${max}）：零跨度轴会让坐标映射` +
            "除零，曲线坐标变 NaN 后从图上整段消失；只有单个数据点时请给出有跨度的范围（如 [" +
            `${min - 1}, ${max + 1}]）`,
          no,
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 归一化坐标点（二元组；JSON Schema 子集不校验长度 ⇒ 运行时兜底见 `assertFigurePayloads`）。 */
const NORMALIZED_POINT_SCHEMA: SatiJsonSchema = {
  type: "array",
  items: { type: "number" },
};

/** 归一化闭合多边形（顶点序列；运行时校验点数与坐标域）。 */
const NORMALIZED_OUTLINE_SCHEMA: SatiJsonSchema = {
  type: "array",
  items: NORMALIZED_POINT_SCHEMA,
};

/** 节点 schema（顶层 nodes 与面板内 nodes 共用同一份定义）。 */
const FIGURE_NODE_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    ref: { type: "integer" },
    shape: { type: "string", enum: FIGURE_NODE_SHAPES },
  },
};

/** 边 schema（顶层 edges 与面板内 edges 共用同一份定义）。 */
const FIGURE_EDGE_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    label: { type: "string" },
    dashed: { type: "boolean" },
  },
};

export const FIGURE_INPUT_SCHEMA_REF: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["figure_no", "kind", "nodes", "edges"],
  properties: {
    figure_no: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: FIGURE_KINDS },
    direction: { type: "string", enum: ["TB", "LR"] },
    abstract: { type: "boolean" },
    nodes: { type: "array", items: FIGURE_NODE_SCHEMA },
    edges: { type: "array", items: FIGURE_EDGE_SCHEMA },
    section: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: {
        parts: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "outline"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              ref: { type: "integer" },
              outline: NORMALIZED_OUTLINE_SCHEMA,
              holes: { type: "array", items: NORMALIZED_OUTLINE_SCHEMA },
              no_hatch: { type: "boolean" },
            },
          },
        },
        cut: { type: "array", items: NORMALIZED_POINT_SCHEMA },
        hatch_spacing: { type: "number" },
        hatch_angle_deg: { type: "number" },
      },
      description: "Section parts (normalized 0..1 outlines), cut line, hatch params.",
    },
    panels: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodes", "edges"],
        properties: {
          title: { type: "string" },
          direction: { type: "string", enum: ["TB", "LR"] },
          nodes: { type: "array", minItems: 1, items: FIGURE_NODE_SCHEMA },
          edges: { type: "array", items: FIGURE_EDGE_SCHEMA },
        },
      },
      description: "Panels (FIG.1A/1B); shared numeral series.",
    },
    chart: {
      type: "object",
      additionalProperties: true,
      required: ["x", "y", "series"],
      properties: {
        x: { type: "object", additionalProperties: true, required: ["title"] },
        y: { type: "object", additionalProperties: true, required: ["title"] },
        series: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: true,
            required: ["points"],
            properties: {
              marker: { type: "string", enum: CHART_MARKERS },
              line: { type: "string", enum: CHART_LINE_STYLES },
            },
          },
        },
      },
    },
  },
};

/**
 * 附图核验发现（`V*` 结构规则、`PX*` 像素规则、`C*` CAD 几何规则共用同一形状）：
 * 三个制图工具 **outputSchema** 的单点定义。
 *
 * 为什么单点：同一份发现会在 generate 的 `check`、check 的 `findings`、project 的
 * `geometry_findings` 三处出现；字段或 severity 枚举各自漂移会让消费方无法用同一段代码
 * 读三处数据（DSH 的 `figure-schemas.ts` 出于同一理由把输出片段集中定义）。
 *
 * ⚠️ 本常量只被 `outputSchema` 引用，**不入**任何 `inputSchema` ⇒ 不影响 llm-replay 的
 * `toolSchemaDigest`，改它不需要重录 fixture（改 inputSchema 才需要）。
 */
export const FIGURE_FINDING_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule", "severity", "message"],
  properties: {
    rule: {
      type: "string",
      description: "规则号（V1–V22 结构 / PX1–PX4 像素 / RC0–RC9 渲染 / DR1–DR3 交付面复核 / C1–C13 CAD 几何）",
    },
    severity: { type: "string", enum: ["fail", "warn", "info"] },
    message: { type: "string" },
    figure_nos: { type: "array", items: { type: "integer" }, description: "涉及的图号（集合级判定）" },
    evidence: { type: "array", items: { type: "string" } },
    metric: { type: "string", enum: ["page_fit", "font_size"], description: "V7 判定维度" },
    advisory: {
      type: "boolean",
      description: "提示级发现：报告但不当成缺陷（不计入缺陷数、不阻断交付）",
    },
  },
};

/**
 * 附图标记映射条目（结构化标号表：组件 → 附图标记）。
 *
 * 为什么进输出契约：标号表是「图面 ↔ 说明书」两向一致性的唯一权威，此前只落在
 * sidecar 与附图说明草稿里，模型在工具输出里拿不到 ⇒ 只能改写文本去猜。对齐
 * deepseek-harness 的 `numeralMap`（其 output 里同样给标号表）。
 */
export const FIGURE_NUMERAL_MAP_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "label", "figure_no"],
  properties: {
    ref: { type: "integer" },
    label: { type: "string" },
    figure_no: { type: "integer" },
  },
};

/**
 * 落版度量（缩放比 + 落版后纸面尺寸与字高）。
 *
 * 为什么进输出契约：模型据它判断「缩小到三分之二是否仍可辨」（指南一部一章 4.3 /
 * PCT Rule 11.13(c) / 37 CFR 1.84(k)）。此前这些值只写在 sidecar 的 `layout` 里，
 * 模型看不到 ⇒ 落版后字高不足这件事只能靠人从文件里量。
 */
export const FIGURE_LAYOUT_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["page_scale", "placed_width_mm", "placed_height_mm", "char_height_mm"],
  properties: {
    page_scale: { type: "number" },
    placed_width_mm: { type: "number" },
    placed_height_mm: { type: "number" },
    char_height_mm: { type: "number" },
    /** 落版页文件（相对产物目录的文件名）。 */
    page_path: { type: "string" },
  },
};

/** 附图产物的 canonical 输出片段（三工具 outputSchema 共用）。 */
export const FIGURE_ARTIFACT_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["figure_no", "path"],
  properties: {
    figure_no: { type: "integer" },
    path: { type: "string" },
    caption: { type: "string" },
    sheet: { type: "string" },
    /** 结构化标号映射（该图上的附图标记 → 组件标签）。 */
    numeral_map: { type: "array", items: FIGURE_NUMERAL_MAP_SCHEMA },
    /** 落版度量（仅产出落版页时存在）。 */
    layout: FIGURE_LAYOUT_SCHEMA,
  },
};

/**
 * 矢量量测条目（`patent_figure_check` 的 `measurements`）。
 *
 * 一条 = 一幅被核验的 SVG 的**量到的数**（不是判据结论）：画布尺寸、文字度量、
 * 线宽分布、线段取向分布。字段语义对齐 deepseek-harness 的 `verify_patent_figure`
 * 输出（DSH 用 camelCase：`widthMm`/`heightMm`/`textCount`/`minFontMm`/
 * `strokeWidthMm`/`orientationDeg`；本仓输出契约统一 snake_case，故改名不改义）。
 *
 * 两条易混语义，声明在此以免消费方误读：
 * - `min_font_mm` 是**实测最小字高**（图上最小的那处文字有多高，毫米），不是判据
 *   下限——判据下限是部署口径，不是量出来的数；DSH 的 `minFontMm` 同此义。
 * - `stroke_width_mm` 升序（线宽由小到大），`orientation_deg` 按线段数降序——
 *   沿用 `render-check` 的既有排序，两处口径一致。
 *
 * ⚠️ 本常量只被 `outputSchema` 引用，**不入**任何 `inputSchema` ⇒ 不影响 llm-replay 的
 * `toolSchemaDigest`，改它不需要重录 fixture。
 */
export const FIGURE_MEASUREMENT_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "text_count", "stroke_width_mm", "orientation_deg"],
  properties: {
    path: { type: "string", description: "被量测的 SVG 产物路径" },
    figure_no: { type: "integer", description: "图号（回读到时给）" },
    width_mm: { type: "number", description: "画布宽（毫米）；根元素未声明时缺省" },
    height_mm: { type: "number", description: "画布高（毫米）；根元素未声明时缺省" },
    text_count: { type: "integer", description: "文字元素数（量到的）" },
    min_font_mm: { type: "number", description: "实测最小字高（毫米）；图中无文字时缺省" },
    stroke_width_mm: {
      type: "array",
      description: "线宽分布（毫米 → 元素数），升序",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["width_mm", "count"],
        properties: {
          width_mm: { type: "number" },
          count: { type: "integer" },
        },
      },
    },
    orientation_deg: {
      type: "array",
      description: "线段取向分布（0–180° → 线段数），按线段数降序",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["orientation_deg", "count"],
        properties: {
          orientation_deg: { type: "number" },
          count: { type: "integer" },
        },
      },
    },
  },
};

/**
 * 栅格附图像素门禁条目（`patent_figure_check` 的 `pixel_images`）。
 *
 * 指标字段与 `pixel-gate.ts` 的 `PixelMetrics` 一一对应（全为可选者按存在才给），
 * 故这里逐个声明而非用 `additionalProperties: true`：契约要能挡住字段漂移。
 */
export const PIXEL_IMAGE_SCHEMA: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "width", "height", "dpi", "dpiEstimated", "inkRatio", "midGrayRatio", "findings"],
  properties: {
    name: { type: "string" },
    width: { type: "integer" },
    height: { type: "integer" },
    dpi: { type: "number" },
    dpiEstimated: { type: "boolean" },
    inkRatio: { type: "number" },
    midGrayRatio: { type: "number" },
    linePx: { type: "number" },
    medianLinePx: { type: "number" },
    printedWidthMm: { type: "number" },
    printedHeightMm: { type: "number" },
    printedLineMm: { type: "number" },
    printedLineShrunkMm: { type: "number" },
    declaredFigureNo: { type: "integer" },
    findings: { type: "array", items: FIGURE_FINDING_SCHEMA },
  },
};
