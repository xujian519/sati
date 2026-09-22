/**
 * patent_figure_* 工具共享的 FigureSpec JSON Schema 与入参归一化。
 *
 * 单一事实源：patent_figure_generate 与 patent_figure_check 的 figures 入参
 * 使用同一 schema（注意：修改描述文本会使 llm-replay fixture 失配，须重录）。
 *
 * 三个制图工具共享法域字段与图幅/页码字段：**归一化收在这一处**，避免三处各写一遍
 * 收窄逻辑后漂移（一处漏掉 `pct` 就会让同一份图在两个工具里按不同法域判定）。
 */

import type { Jurisdiction } from "../../patent/figuregen/index.js";
import type { SatiJsonSchema } from "../protocol/schema.js";

/** 法域取值（三工具 inputSchema 的 enum 与此同源；运行时收窄见 `toJurisdiction`）。 */
export const JURISDICTIONS: string[] = ["cn", "us", "pct"];

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
      enum: ["flowchart", "block"],
      description: "flowchart=方法流程图（默认纵向），block=系统结构框图（默认横向）",
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
            enum: ["rect", "round", "diamond", "ellipse", "cylinder", "parallelogram"],
            description: "节点形状；缺省矩形",
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
