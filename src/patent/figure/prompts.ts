/**
 * src/patent/figure — 附图分析提示词与 JSON Schema。
 *
 * 方法依据：
 * - PatentVision（arXiv:2510.09762）：图文对齐——权利要求/技术方案文本作为
 *   视觉输入的上下文，提升组件识别与说明书生成质量。
 * - PatentLMM（arXiv:2501.15074）：专利附图有独特结构元素（虚线/剖面线/
 *   标号/箭头），通用 VLM 需要领域引导。此处以静态附图规范要点注入逼近
 *   PatentMME 的领域先验（不微调）。
 *
 * 采用两步法：Step1 分类+整体理解，Step2 结构化提取+附图说明生成。
 */

import type { FigureType } from "./types.js";

/** 附图规范要点（静态注入，来源：专利实务附图规范常识，与 wiki 附图卡片一致）。 */
export const FIGURE_SPEC_GUIDE = [
  "专利附图是黑白线图，不要求也不允许彩色；虚线表示不可见/隐藏结构，剖面线表示剖切面。",
  "阿拉伯数字为附图标记（引用符号），指向对应部件；说明书正文引用必须与标号一一对应。",
  "箭头表示连接方向、运动方向或流程走向。",
  "同一部件在不同附图中共用同一标号；标号不得跳号或重复。",
  "附图说明句式：'图N是本发明实施例提供的{发明名称}的{附图类型}；图中：1-{部件}；2-{部件}；…'",
].join("\n");

/** Step1 输出 JSON Schema（附图类型分类 + 整体理解）。 */
export const STEP1_SCHEMA = {
  type: "object",
  properties: {
    figure_type: {
      type: "string",
      enum: [
        "structure",
        "flowchart",
        "circuit",
        "block_diagram",
        "schematic",
        "exploded_view",
        "cross_section",
        "unknown",
      ],
      description:
        "附图类型：structure=结构图、flowchart=流程图、circuit=电路图、block_diagram=方框图、schematic=示意图、exploded_view=分解图、cross_section=剖视图",
    },
    overall_description: { type: "string", description: "附图整体内容的一句话描述" },
    confidence: { type: "number", description: "分类置信度 0-1" },
    notes: { type: "array", items: { type: "string" }, description: "观察要点（如剖视符号、虚线结构等）" },
  },
  required: ["figure_type", "overall_description", "confidence"],
} as const;

/** Step2 输出 JSON Schema（组件/连接/附图说明）。 */
export const STEP2_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref_number: {
            type: "string",
            description: "附图标记号（与图面阿拉伯数字完全一致；无标号部件用 U1/U2… 并注明）",
          },
          name: { type: "string", description: "组件名称" },
          kind: {
            type: "string",
            enum: ["mechanical", "electrical", "software", "interface", "sensor", "actuator", "controller", "unknown"],
            description: "组件类型",
          },
          description: { type: "string", description: "组件功能描述" },
        },
        required: ["ref_number", "name", "kind"],
      },
    },
    connections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "源组件标号" },
          target: { type: "string", description: "目标组件标号" },
          kind: { type: "string", enum: ["electrical", "mechanical", "data_flow", "unknown"], description: "连接类型" },
          description: { type: "string", description: "连接关系描述" },
        },
        required: ["source", "target", "kind"],
      },
    },
    figure_description: {
      type: "string",
      description: "附图说明文字（专利格式：图N是本发明实施例提供的{发明名称}的{附图类型}；图中：1-…；2-…；）",
    },
    warnings: { type: "array", items: { type: "string" }, description: "无法识别或标号异常的区域" },
  },
  required: ["components", "connections", "figure_description", "warnings"],
} as const;

export type Step1Result = {
  figure_type: string;
  overall_description: string;
  confidence: number;
  notes?: string[];
};

export type Step2Result = {
  components: Array<{
    ref_number: string;
    name: string;
    kind: string;
    description?: string;
  }>;
  connections: Array<{
    source: string;
    target: string;
    kind: string;
    description?: string;
  }>;
  figure_description: string;
  warnings?: string[];
};

function formatContext(claimContext: string | undefined): string {
  return claimContext && claimContext.trim().length > 0
    ? `\n【权利要求/技术方案上下文】\n${claimContext.trim().slice(0, 4000)}`
    : "\n【权利要求/技术方案上下文】\n（未提供）";
}

/** Step1 提示词：附图类型分类 + 整体理解。 */
export function buildStep1Prompt(figureNumber: number, claimContext: string | undefined): string {
  return [
    "你是一位资深专利代理师与专利审查专家。下面是一张专利说明书附图（图" + figureNumber + "）。请完成两项任务：",
    "1. 判断附图类型（结构图/流程图/电路图/方框图/示意图/分解图/剖视图之一）；",
    "2. 用一句话概述附图展示的技术内容。",
    "",
    "【专利附图规范要点】",
    FIGURE_SPEC_GUIDE,
    formatContext(claimContext),
    "",
    "严格输出 JSON，不要输出其他内容：",
    JSON.stringify(STEP1_SCHEMA, null, 2),
  ].join("\n");
}

/** Step2 提示词：组件/连接/标记结构化提取 + 附图说明生成。 */
export function buildStep2Prompt(
  figureNumber: number,
  figureType: FigureType,
  overallDescription: string,
  claimContext: string | undefined,
): string {
  return [
    "基于附图类型与整体描述，提取这张专利附图中的技术组件与连接关系，并撰写附图说明。",
    "",
    `附图编号：图${figureNumber}`,
    `附图类型：${figureType}`,
    `整体描述：${overallDescription || "（未提供）"}`,
    "",
    "【专利附图规范要点】",
    FIGURE_SPEC_GUIDE,
    formatContext(claimContext),
    "",
    "【提取要求】",
    "- 组件标号必须与图面阿拉伯数字完全一致，不得改写或跳号；",
    "- 无标号但明显存在的部件用 U1/U2… 编号并在 warnings 中注明'未标注'；",
    "- 无法识别的区域写入 warnings，不要猜测；",
    "- 附图说明使用专利格式，发明名称未知时用'装置'代替。",
    "",
    "严格输出 JSON，不要输出其他内容：",
    JSON.stringify(STEP2_SCHEMA, null, 2),
  ].join("\n");
}
