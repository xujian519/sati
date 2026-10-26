/**
 * patent_figure_* 工具共享的 FigureSpec JSON Schema 与入参归一化。
 *
 * 单一事实源：patent_figure_generate 与 patent_figure_check 的 figures 入参
 * 使用同一 schema（注意：修改描述文本会使 llm-replay fixture 失配，须重录）。
 *
 * 三个制图工具共享法域字段与图幅/页码字段：**归一化收在这一处**，避免三处各写一遍
 * 收窄逻辑后漂移（一处漏掉 `pct` 就会让同一份图在两个工具里按不同法域判定）。
 */

import type { FigureSpec, Jurisdiction } from "../../patent/figuregen/index.js";
import { isRefNumeral } from "../../patent/figuregen/numeral.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiJsonSchema } from "../protocol/schema.js";

/** 法域取值（三工具 inputSchema 的 enum 与此同源；运行时收窄见 `toJurisdiction`）。 */
export const JURISDICTIONS: string[] = ["cn", "us", "pct"];

/** 图型取值（schema enum 与 `FigureKind` 同源；同步守卫见 tests/patent/figuregen/tools.spec.ts）。 */
export const FIGURE_KINDS: string[] = ["flowchart", "block", "state", "hierarchy", "chart"];

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
 * figures 入参的结构性校验（`patent_figure_generate` 与 `patent_figure_check` 共用）。
 *
 * JSON Schema 只挡类型/枚举/未知属性（`src/tool/execution/validateToolInput.ts` 不校验
 * `minItems`/`maxItems`），条数与成对性在这里兜底，避免"空节点图"或"没有数据点的曲线"
 * 静默出一张空图：
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
    if (Array.isArray(figure.nodes)) {
      for (const node of figure.nodes) {
        if (node.ref !== undefined && !isRefNumeral(node.ref)) {
          invalid(
            `图${no} 节点「${node.id}」的附图标记应为正整数（收到 ${String(node.ref)}）：` +
              "0、负数或小数无法作为可引用的标记",
            no,
          );
        }
      }
    }
    if (figure.kind !== "chart") {
      if (!Array.isArray(figure.nodes) || figure.nodes.length === 0) {
        invalid(`图${no} 的 nodes 不能为空`, no);
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

export const FIGURE_INPUT_SCHEMA_REF: SatiJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["figure_no", "kind", "nodes", "edges"],
  properties: {
    figure_no: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: FIGURE_KINDS },
    direction: { type: "string", enum: ["TB", "LR"] },
    abstract: { type: "boolean" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          ref: { type: "integer" },
          shape: { type: "string", enum: FIGURE_NODE_SHAPES },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          label: { type: "string" },
          dashed: { type: "boolean" },
        },
      },
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
    rule: { type: "string", description: "规则号（V1–V22 结构 / PX1–PX4 像素 / RC0–RC5 渲染 / C1–C12 CAD 几何）" },
    severity: { type: "string", enum: ["fail", "warn", "info"] },
    message: { type: "string" },
    figure_nos: { type: "array", items: { type: "integer" }, description: "涉及的图号（集合级判定）" },
    evidence: { type: "array", items: { type: "string" } },
    metric: { type: "string", enum: ["page_fit", "font_size"], description: "V7 判定维度" },
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
