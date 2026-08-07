/**
 * src/patent/chemistry — 化学式识别提示词与 JSON Schema（VLM 两步法）。
 *
 * 方法对齐 src/patent/figure/prompts.ts：提示词约束 JSON 输出 + 容错解析；
 * 不依赖 structured output 工具。
 *
 * 防幻觉约定（评审 H1）：Step2 / 名称转换要求输出多候选 SMILES 列表（top-3），
 * 不确定时输出 null 并附理由，禁止编造；候选经 RDKit 校验后选优。
 */

import type { ChemicalKind } from "./types.js";

/** 化学结构规范要点（静态注入，来源：化学实务常识）。 */
export const CHEMISTRY_SPEC_GUIDE = [
  "专利化学结构图通常为黑白线图：实线表示单键，楔形实线表示朝向观察者的立体键，楔形虚线表示背离观察者的立体键。",
  "结构图中的字母（如 R、R1、Ar、X）为取代基变量，构成 Markush 广义结构；原子标签（N、O、S、Cl 等）标注杂原子。",
  "SMILES 书写规则：有机子集原子可省略碳的 C 与碳上的氢；双键 =、三键 #，环闭合用成对数字标注，分支用括号 ()，方括号 [] 标注非有机子集原子/电荷/同位素。",
  "输出 SMILES 必须是化学上可解析的合法字符串；对不确定的原子/键输出 null 并说明理由，绝对禁止编造。",
].join("\n");

/** Step1（图片）：是否化学结构图 + 类型判定。 */
export type Step1Result = {
  is_chemical: boolean;
  kind: ChemicalKind | null;
  overall_description: string;
  confidence: number;
  notes?: string[];
};

/** Step2 / 名称转换：多候选 SMILES + 名称 + 分子式。 */
export type StructureResult = {
  kind: ChemicalKind;
  candidates: Array<{ smiles: string | null; confidence: number }>;
  names: string[];
  formula?: string;
  warnings?: string[];
};

/** 文本复核：筛选公式/SMILES 候选并输出化合物名称的 SMILES 转换。 */
export type TextReviewResult = {
  kind: ChemicalKind;
  kept_formulas: string[];
  kept_smiles: string[];
  names: Array<{ name: string; smiles: string | null; confidence: number }>;
  warnings?: string[];
};

function formatContext(claimContext: string | undefined): string {
  return claimContext && claimContext.trim().length > 0
    ? `\n【权利要求/技术方案上下文】\n${claimContext.trim().slice(0, 4000)}`
    : "\n【权利要求/技术方案上下文】\n（未提供）";
}

/** Step1 提示词：判定是否化学结构图 + 类型 + 整体理解。 */
export function buildStep1Prompt(claimContext: string | undefined): string {
  return [
    "你是一位资深化合物化学专家与专利代理师。下面是一张图片，请完成两项任务：",
    "1. 判断图片是否为化学相关图示：化学结构式（含 Markush 广义结构）、分子式文本渲染，或纯机械/电路/流程图；",
    "2. 用一句话概述图片展示的化学内容（非化学图则概述其内容并标注 is_chemical=false）。",
    "",
    "【化学结构规范要点】",
    CHEMISTRY_SPEC_GUIDE,
    formatContext(claimContext),
    "",
    "严格输出 JSON，不要输出其他内容：",
    JSON.stringify(
      {
        type: "object",
        properties: {
          is_chemical: { type: "boolean", description: "是否为化学相关图示" },
          kind: { type: ["string", "null"], enum: ["formula", "structure", "markush", null] },
          overall_description: { type: "string" },
          confidence: { type: "number", description: "分类置信度 0-1" },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["is_chemical", "kind", "overall_description", "confidence"],
      },
      null,
      2,
    ),
  ].join("\n");
}

/** Step2 提示词：结构化提取多候选 SMILES + 名称 + 分子式。 */
export function buildStep2Prompt(step1Description: string, claimContext: string | undefined): string {
  return [
    "你是一位资深化合物化学专家。请根据图片中的化学结构，提取其结构信息。",
    "",
    "【图片内容概述（Step1 判定）】",
    step1Description,
    "",
    "【化学结构规范要点】",
    CHEMISTRY_SPEC_GUIDE,
    formatContext(claimContext),
    "",
    "【输出要求】",
    "- candidates：给出最多 3 个候选 SMILES（按置信度降序）；对不确定的候选输出 null 并附 warnings 说明，禁止编造；",
    "- kind：structure（确定结构式）/ markush（含 R 基团变量的广义结构）/ formula（纯分子式文本图，此时 candidates 可为空数组、填写 formula）；",
    "- names：化合物名称（中文名/英文名/商品名，1-5 个）；",
    "- formula：分子式（如 C9H8O4；不确定可省略）。",
    "",
    "严格输出 JSON，不要输出其他内容：",
    JSON.stringify(
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["formula", "structure", "markush"] },
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                smiles: { type: ["string", "null"] },
                confidence: { type: "number", description: "候选置信度 0-1" },
              },
              required: ["smiles", "confidence"],
            },
          },
          names: { type: "array", items: { type: "string" } },
          formula: { type: "string" },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "candidates", "names"],
      },
      null,
      2,
    ),
  ].join("\n");
}

/** 名称→SMILES 单步提示词（H2 选 a：由 VLM 承担，不引入 OPSIN）。 */
export function buildNameToSmilesPrompt(name: string): string {
  return [
    "你是一位资深化合物化学专家。请将下面的化合物名称转换为 SMILES 结构。",
    "",
    "【化合物名称】",
    name,
    "",
    "【化学结构规范要点】",
    CHEMISTRY_SPEC_GUIDE,
    "",
    "【输出要求】",
    "- candidates：给出最多 3 个候选 SMILES（按置信度降序）；对无法确定命名的化合物输出 null 并附 warnings 说明理由，禁止编造；",
    "- names：确认的名称（可含别名）；",
    "- formula：分子式（可省略）。",
    "",
    "严格输出 JSON，不要输出其他内容：",
    JSON.stringify(
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["formula", "structure", "markush"] },
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                smiles: { type: ["string", "null"] },
                confidence: { type: "number", description: "候选置信度 0-1" },
              },
              required: ["smiles", "confidence"],
            },
          },
          names: { type: "array", items: { type: "string" } },
          formula: { type: "string" },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "candidates", "names"],
      },
      null,
      2,
    ),
  ].join("\n");
}

/** 文本复核提示词（三级流水线第二级：LLM 筛选正则候选 + 名称转换）。 */
export function buildTextReviewPrompt(text: string, formulas: string[], smilesTokens: string[]): string {
  const excerpt = text.trim().slice(0, 4000);
  return [
    "你是一位资深化合物化学专家。下面是专利文档片段及从中自动提取的候选词元，请完成两项任务：",
    "1. 筛选：剔除候选中的噪声（章节号、范围写法、商品编号、随机符号串），保留真实化学实体；",
    "2. 转换：从文档片段中识别化合物名称（中文/英文/商品名，最多 5 个），并为每个名称给出 SMILES 候选（不确定时输出 null 并说明理由，禁止编造）。",
    "",
    "【文档片段】",
    excerpt || "（空）",
    "",
    "【自动提取的分子式候选】",
    formulas.length > 0 ? formulas.join("、") : "（无）",
    "",
    "【自动提取的类 SMILES 候选】",
    smilesTokens.length > 0 ? smilesTokens.join("、") : "（无）",
    "",
    "【化学结构规范要点】",
    CHEMISTRY_SPEC_GUIDE,
    "",
    "严格输出 JSON，不要输出其他内容：",
    JSON.stringify(
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["formula", "structure", "markush"] },
          kept_formulas: { type: "array", items: { type: "string" } },
          kept_smiles: { type: "array", items: { type: "string" } },
          names: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                smiles: { type: ["string", "null"] },
                confidence: { type: "number", description: "转换置信度 0-1" },
              },
              required: ["name", "smiles", "confidence"],
            },
          },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "kept_formulas", "kept_smiles", "names"],
      },
      null,
      2,
    ),
  ].join("\n");
}
