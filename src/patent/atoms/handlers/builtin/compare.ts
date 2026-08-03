/**
 * 对比域原子：compare（权利要求特征对比 chart）+ novelty（逐特征新颖性初判）。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from "../../handler.js";
import { callLlm, degraded, formatPriorArt, parseLlmJson, requireLlm, resolveInputText } from "./llm.js";

// ---------------------------------------------------------------------------
// compare —— 特征对比（claim chart）
// ---------------------------------------------------------------------------

export const compareAtom: Atom = {
  name: "compare",
  description: "逐项对比权利要求特征与现有技术，输出结构化对比表（claim chart）",
  category: "compare",
  inputSchema: ["claim", "prior_art", "comparison_scope"],
  outputSchema: ["claim_chart", "diff_features"],
};

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    claim_chart: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feature: { type: "string", description: "权利要求特征" },
          prior_art_match: { type: "string", description: "现有技术对应内容（无则填空）" },
          identical: { type: "boolean", description: "是否相同" },
          note: { type: "string" },
        },
        required: ["feature"],
      },
    },
    diff_features: { type: "array", items: { type: "string" }, description: "区别技术特征" },
  },
  required: ["claim_chart"],
} as const;

export class CompareHandler implements StageHandler {
  readonly name = "compare";
  readonly category = "compare" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "compare");
    if (missing) return missing;
    const claim = resolveInputText(state, ["claim", "claim_text"], "");
    if (claim.trim().length === 0) {
      return degraded("compare", "权利要求为空");
    }
    const priorArt = formatPriorArt(state);
    const scope = getStateString(state, "comparison_scope") || "单独对比原则（新颖性）";
    const prompt = [
      `对比范围：${scope}`,
      "权利要求：",
      "```",
      claim.slice(0, 4000),
      "```",
      "现有技术：",
      "```",
      priorArt.slice(0, 6000),
      "```",
      "请逐项对比，严格输出 JSON（claim_chart 每项含 feature/prior_art_match/identical/note，diff_features 为区别特征）。",
    ].join("\n");
    const res = await callLlm(provider, "compare", prompt, { schema: COMPARE_SCHEMA, temperature: 0 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      parsed => {
        if (!Array.isArray(parsed.claim_chart)) return null;
        return {
          claim_chart: parsed.claim_chart,
          diff_features: Array.isArray(parsed.diff_features) ? parsed.diff_features : [],
        };
      },
      raw => ({ claim_chart: raw }),
    );
  }
}

// ---------------------------------------------------------------------------
// novelty —— 逐特征新颖性初判（移植 Mady disclosure/novelty.go 语义）
// ---------------------------------------------------------------------------
//
// 消费 extract 产出的 features + search 产出的 prior_art 证据片段，
// 按单独对比原则（专利法 A22.2）逐特征判定是否被现有技术公开。
// evidence_coverage 对齐 Mady：无证据 → none（提示不可靠），1-2 条 → partial，≥3 → full。

export const noveltyAtom: Atom = {
  name: "novelty",
  description: "逐特征新颖性初判：结合现有技术证据（prior_art）按单独对比原则判定",
  category: "compare",
  inputSchema: ["features", "prior_art", "novelty_scope"],
  outputSchema: ["novelty_result", "novelty_conclusion", "evidence_coverage"],
};

const NOVELTY_SCHEMA = {
  type: "object",
  properties: {
    assessments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feature: { type: "string", description: "技术特征" },
          prior_art: { type: "string", description: "公开该特征的现有技术来源（无则空）" },
          disclosed: { type: "boolean", description: "是否被现有技术单独公开" },
          reasoning: { type: "string", description: "判断依据" },
        },
        required: ["feature", "disclosed"],
      },
    },
    conclusion: { type: "string", description: "整体新颖性结论（具备/不具备，附置信度）" },
  },
  required: ["assessments"],
} as const;

/** 证据覆盖分级：≥3 条 full；1-2 条 partial；0 条 none。 */
export function evidenceCoverage(count: number): "full" | "partial" | "none" {
  if (count >= 3) return "full";
  if (count >= 1) return "partial";
  return "none";
}

export class NoveltyHandler implements StageHandler {
  readonly name = "novelty";
  readonly category = "compare" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const features = getStateArray(state, "features");
    if (features.length === 0) {
      return degraded("novelty", "无特征可评估（state.features 为空）");
    }
    const missing = requireLlm(provider, "novelty");
    if (missing) return missing;
    const priorArt = formatPriorArt(state);
    const coverage = evidenceCoverage(getStateArray(state, "prior_art").length);
    const scope = getStateString(state, "novelty_scope") || "单独对比原则（新颖性，专利法 A22.2）";
    const featureLines = features.map((f, i) => `[${i + 1}] ${String(f)}`).join("\n");
    const prompt = [
      `你是专利新颖性分析专家。对比范围：${scope}`,
      "要求：",
      "- 单独对比原则：逐特征与单份现有技术对比，不得将多份文件结合后认定公开",
      "- 仅基于证据片段明确公开的内容判断，不含推测",
      "- 区别特征为 0 时结论为不具备新颖性",
      "",
      "【技术特征】",
      featureLines,
      "",
      "【现有技术证据】",
      priorArt.slice(0, 6000),
      "",
      "请严格输出 JSON：assessments 为每个特征的 { feature, prior_art, disclosed, reasoning } 列表，",
      "conclusion 为整体新颖性结论（附置信度）。",
    ].join("\n");
    const res = await callLlm(provider, "novelty", prompt, { schema: NOVELTY_SCHEMA, temperature: 0.1 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      parsed => {
        if (!Array.isArray(parsed.assessments)) return null;
        return {
          novelty_result: JSON.stringify(parsed),
          novelty_conclusion: typeof parsed.conclusion === "string" ? parsed.conclusion : "",
          evidence_coverage: coverage,
        };
      },
      raw => ({ novelty_result: raw, evidence_coverage: coverage }),
    );
  }
}
