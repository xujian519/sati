/**
 * 提取域原子：extract（结构化抽取，按 output_key 分键）+ merge（PFE 三路融合）。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from "../../handler.js";
import { callLlm, degraded, parseLlmJson, requireLlm, resolveInputText } from "./llm.js";

// ---------------------------------------------------------------------------
// extract —— 结构化抽取（JSON Schema 约束）
// ---------------------------------------------------------------------------

export const extractAtom: Atom = {
  name: "extract",
  description: "从文本中结构化抽取特征/问题/效果（JSON Schema 约束 LLM 输出）",
  category: "extract",
  inputSchema: ["text", "extraction_type", "domain", "output_key"],
  outputSchema: ["extraction_result", "features", "problems", "effects"],
};

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    features: { type: "array", items: { type: "string" }, description: "技术特征列表" },
    problems: { type: "array", items: { type: "string" }, description: "要解决的技术问题" },
    effects: { type: "array", items: { type: "string" }, description: "技术效果" },
  },
  required: ["features"],
} as const;

export class ExtractHandler implements StageHandler {
  readonly name = "extract";
  readonly category = "extract" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "extract");
    if (missing) return missing;
    const text = resolveInputText(state, ["text", "extraction_input"], "");
    if (text.trim().length === 0) {
      return degraded("extract", "输入文本为空");
    }
    const extractionType = getStateString(state, "extraction_type") || "技术特征抽取";
    const domain = getStateString(state, "domain") || "专利";
    // 按任务分键（经 stage.params.output_key 注入）：三路提取互不覆盖。
    // 缺省时保持旧行为（全量写 features/problems/effects）。
    const outputKey = getStateString(state, "output_key");
    const prompt = [
      `你是 ${domain} 领域的技术分析助手。任务：${extractionType}。`,
      "请从以下文本中提取结构化结果，严格输出 JSON：",
      "```",
      text.slice(0, 8000),
      "```",
    ].join("\n");
    const res = await callLlm(provider, "extract", prompt, { schema: EXTRACT_SCHEMA, temperature: 0 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      (parsed, raw) => {
        // 按 output_key 检查对应字段（2026-08 修复：此前统一检查 parsed.features，
        // problems/effects 路 LLM 输出无 features → 解析恒失败 → problems/effects
        // 永不写入 state → merge 产生空 problem → consistency 误判孤立 → retry 循环）。
        if (outputKey === "features" && !Array.isArray(parsed.features)) return null;
        if (outputKey === "problems" && !Array.isArray(parsed.problems)) return null;
        if (outputKey === "effects" && !Array.isArray(parsed.effects)) return null;
        if (outputKey === "features" || outputKey === "problems" || outputKey === "effects") {
          const segment: PipelineState = { extraction_result: raw };
          if (outputKey === "features") segment.features = parsed.features;
          if (outputKey === "problems") segment.problems = parsed.problems;
          if (outputKey === "effects") segment.effects = parsed.effects;
          return segment;
        }
        // 无 output_key（旧行为）：全量写。
        return {
          extraction_result: raw,
          features: parsed.features,
          problems: Array.isArray(parsed.problems) ? parsed.problems : [],
          effects: Array.isArray(parsed.effects) ? parsed.effects : [],
        };
      },
      raw => ({ extraction_result: raw }),
    );
  }
}

// ---------------------------------------------------------------------------
// merge —— PFE 三路提取融合（移植 Mady disclosure/graph.go mergeExtractionsNode）
// ---------------------------------------------------------------------------
//
// 确定性实现（无 LLM）：读 extract 三路分键产出的 problems/features/effects，
// 按索引配对为 PFE 三元组（问题为锚点），多余特征/效果并入末组；全部为空时降级。

export const mergeAtom: Atom = {
  name: "merge",
  description: "融合 PFE 三路提取结果（问题↔特征↔效果交叉引用），产出 PFE 三元组",
  category: "extract",
  inputSchema: ["features", "problems", "effects"],
  outputSchema: ["pfe_triples", "merge_result"],
};

export type PFETriple = {
  id: string;
  problem: string;
  features: string[];
  effects: string[];
};

export class MergeHandler implements StageHandler {
  readonly name = "merge";
  readonly category = "extract" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const features = getStateArray(state, "features").map(String).filter(Boolean);
    const problems = getStateArray(state, "problems").map(String).filter(Boolean);
    const effects = getStateArray(state, "effects").map(String).filter(Boolean);
    if (features.length + problems.length + effects.length === 0) {
      return degraded("merge", "三路提取结果均为空（state.features/problems/effects）");
    }
    const triples: PFETriple[] = problems.map((problem, i) => ({
      id: `T${i + 1}`,
      problem,
      features: features[i] !== undefined ? [features[i]] : [],
      effects: effects[i] !== undefined ? [effects[i]] : [],
    }));
    // 多于问题数的特征/效果并入最后一个三元组（无问题时构造单一三元组）。
    const extraFeatures = features.slice(problems.length);
    const extraEffects = effects.slice(problems.length);
    if (extraFeatures.length > 0 || extraEffects.length > 0) {
      if (triples.length > 0) {
        const last = triples[triples.length - 1];
        last.features.push(...extraFeatures);
        last.effects.push(...extraEffects);
      } else {
        triples.push({ id: "T1", problem: "", features: [...features], effects: [...effects] });
      }
    }
    const summary = `PFE 融合：${problems.length} 个问题 / ${features.length} 个特征 / ${effects.length} 个效果`;
    return { pfe_triples: triples, merge_result: summary };
  }
}
