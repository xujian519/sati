/**
 * patent_figure_* 工具共享的 FigureSpec JSON Schema。
 *
 * 单一事实源：patent_figure_generate 与 patent_figure_check 的 figures 入参
 * 使用同一 schema（注意：修改描述文本会使 llm-replay fixture 失配，须重录）。
 */

import type { SatiJsonSchema } from "../protocol/schema.js";

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
