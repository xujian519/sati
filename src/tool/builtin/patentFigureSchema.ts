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
    figure_no: {
      type: "integer",
      minimum: 1,
      description: "图号（图1、图2…按 1..N 连续编号，细则第 21 条）",
    },
    kind: {
      type: "string",
      enum: FIGURE_KINDS,
      description:
        "flowchart=方法流程图（默认纵向），block=系统结构框图（默认横向），" +
        "state=状态转移图（纵向；初态 circle、终态 doublecircle），hierarchy=组件层级图（纵向；连线表示包含关系，不画箭头），" +
        "chart=曲线图/坐标图（数值数据；须另给 chart 字段，nodes/edges 留空数组）",
    },
    chart: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "series"],
      description: "曲线图数据（kind=chart 时必填；其余图型忽略）",
      properties: {
        x: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          description: "横轴（恒为横向，画在下方）",
          properties: {
            title: { type: "string", description: "轴标目，含单位，如 时间(h)、转化率(%)" },
            min: { type: "number", description: "范围下限；缺省按数据推导并按 1/2/2.5/5 步长取整" },
            max: { type: "number", description: "范围上限；缺省按数据推导" },
            ticks: { type: "integer", minimum: 2, maximum: 12, description: "目标刻度数（含两端），缺省 5" },
          },
        },
        y: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          description: "纵轴（恒为纵向，画在左侧）",
          properties: {
            title: { type: "string", description: "轴标目，含单位，如 温度(℃)、强度(a.u.)" },
            min: { type: "number", description: "范围下限；缺省按数据推导" },
            max: { type: "number", description: "范围上限；缺省按数据推导" },
            ticks: { type: "integer", minimum: 2, maximum: 12, description: "目标刻度数（含两端），缺省 5" },
          },
        },
        series: {
          type: "array",
          minItems: 1,
          description: "数据曲线（至少 1 条）",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["points"],
            properties: {
              name: { type: "string", description: "序列名（图例文本）；缺省则该曲线不上图例" },
              points: {
                type: "array",
                minItems: 1,
                description: "数据点 [x, y]（按 x 升序给出，按给定顺序连线，不重排）",
                items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
              },
              marker: {
                type: "string",
                enum: CHART_MARKERS,
                description: "标记形状；缺省自动分配不同标记（黑白附图不得用颜色区分曲线）",
              },
              line: { type: "string", enum: CHART_LINE_STYLES, description: "线型；缺省实线" },
            },
          },
        },
        grid: { type: "boolean", description: "是否画网格线（默认 false）" },
        legend: { type: "boolean", description: "是否写图例（默认 true；只列有 name 的序列）" },
      },
    },
    direction: { type: "string", enum: ["TB", "LR"], description: "布局方向，缺省按 kind 取默认" },
    abstract: {
      type: "boolean",
      description: "指定为摘要附图（多图时应指定一幅，指南一部一章 4.5.2）",
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string", description: "稳定节点 id（跨图同一组件沿用同一 id）" },
          label: {
            type: "string",
            description: "节点文本，可含 \\n 换行；建议含附图标记如 处理模块(20)",
          },
          ref: { type: "integer", description: "专利附图标记（细则第 21 条双向核验对象）" },
          shape: {
            type: "string",
            enum: FIGURE_NODE_SHAPES,
            description:
              "节点形状；缺省矩形。状态图：round=状态、circle=初态、doublecircle=终态；" +
              "circle/doublecircle 为符号形状，不渲染文字（label 请留空，勿写标记）",
          },
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
          label: { type: "string", description: "边标签（判断分支的 是/否）" },
          dashed: { type: "boolean", description: "虚线边（可选/隐含路径）" },
        },
      },
    },
  },
};
