/**
 * 推理域原子：reasoning（自由推理）+ groundedness（提取特征原文依据过滤）。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from "../../handler.js";
import { callLlm, degraded, parseLlmJson, requireLlm } from "./llm.js";

// ---------------------------------------------------------------------------
// reasoning —— 自由推理
// ---------------------------------------------------------------------------

export const reasoningAtom: Atom = {
  name: "reasoning",
  description: "基于状态中的既有结果进行自由推理，产出结论（附置信度提示）",
  category: "reason",
  inputSchema: ["reasoning_prompt", "reasoning_input"],
  outputSchema: ["reasoning_output", "conclusion"],
};

export class ReasoningHandler implements StageHandler {
  readonly name = "reasoning";
  readonly category = "reason" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "reasoning");
    if (missing) return missing;
    const explicitPrompt = getStateString(state, "reasoning_prompt").trim();
    const explicitInput = getStateString(state, "reasoning_input").trim();
    const defaultPrompt = "基于以下工作流上下文，给出专业分析结论（如涉及法律判断，请附置信度与依据）：";
    const input = explicitInput.length > 0 ? explicitInput : formatStateForReasoning(state);
    const prompt = [
      explicitPrompt.length > 0 ? explicitPrompt : defaultPrompt,
      "```",
      input.slice(0, 8000),
      "```",
    ].join("\n");
    const res = await callLlm(provider, "reasoning", prompt, { temperature: 0.2 });
    if (!res.ok) return res.error;
    return { reasoning_output: res.raw, conclusion: res.raw };
  }
}

/** 拼接非元数据状态为文本块（reasoning 无显式输入时的兜底）。 */
function formatStateForReasoning(state: PipelineState): string {
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith("_")) continue; // 跳过 _error 等元数据
    if (typeof value === "string" && value.trim().length > 0) {
      blocks.push(`## ${key}\n${value}`);
    } else if (Array.isArray(value) && value.length > 0) {
      blocks.push(`## ${key}\n${JSON.stringify(value, null, 2)}`);
    }
  }
  return blocks.join("\n\n") || "(无可用上下文)";
}

// ---------------------------------------------------------------------------
// groundedness —— 提取特征原文依据过滤（移植 Mady disclosure/groundedness.go）
// ---------------------------------------------------------------------------
//
// 在 merge → consistency 之间插入：批处理 LLM 一次评估所有特征在原始交底书中
// 是否有坚实依据（0-1 分数）。低分特征（< 0.6）汇总为反馈供下游修订。
// LLM 调用失败 fail-open（返回 skipped 标记，不阻塞管线）。

export const groundednessAtom: Atom = {
  name: "groundedness",
  description: "批量评估提取特征在原始交底书中的原文依据（0-1 分数，低分特征反馈）",
  category: "reason",
  inputSchema: ["features", "source_text"],
  outputSchema: ["groundedness_result", "groundedness_feedback", "low_confidence_features"],
};

const GROUNDEDNESS_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feature: { type: "string", description: "特征描述（与输入一致）" },
          score: { type: "number", description: "原文依据分数 0-1" },
          reason: { type: "string", description: "依据说明（引用原文片段）" },
        },
        required: ["feature", "score"],
      },
    },
    feedback: { type: "string", description: "整体反馈与低分特征修改建议" },
  },
  required: ["scores"],
} as const;

/** 低依据阈值（对齐 Mady：分数 < 0.6 视为依据不足）。 */
export const GROUNDEDNESS_THRESHOLD = 0.6;

export class GroundednessHandler implements StageHandler {
  readonly name = "groundedness";
  readonly category = "reason" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const features = getStateArray(state, "features");
    if (features.length === 0) {
      // 无特征可过滤，跳过（对齐 Mady GroundednessResult.Skipped）。
      return { groundedness_result: "skipped", groundedness_feedback: "无特征可评估，跳过 groundedness 过滤" };
    }
    const missing = requireLlm(provider, "groundedness");
    if (missing) return missing;
    const source = getStateString(state, "source_text");
    if (source.trim().length === 0) {
      return degraded("groundedness", "原文缺失（state.source_text 为空）");
    }
    const featureLines = features.map((f, i) => `[${i + 1}] ${String(f)}`).join("\n");
    const prompt = [
      "你是专利技术交底书分析师。请评估以下每个提取的技术特征是否在原始交底书中有坚实原文依据。",
      "打分规则：",
      "- 1.0：原文明确记载该特征",
      "- 0.6-0.9：原文有部分依据，但表述不够明确",
      "- <0.6：原文未记载或仅能推断，属于提取幻觉",
      "",
      "【原始交底书】",
      "```",
      source.slice(0, 8000),
      "```",
      "",
      "【待评估特征】",
      featureLines,
      "",
      "请严格输出 JSON：scores 为每个特征的 { feature, score, reason } 列表（feature 与输入一致），",
      "feedback 为整体反馈与低分特征（score < 0.6）的修改建议。",
    ].join("\n");
    const res = await callLlm(provider, "groundedness", prompt, { schema: GROUNDEDNESS_SCHEMA, temperature: 0.1 });
    if (!res.ok) {
      // fail-open：LLM 失败不阻塞管线（对齐 Mady）。
      return {
        groundedness_result: "skipped",
        groundedness_feedback: `LLM 调用失败，跳过 groundedness 过滤: ${res.message}`,
      };
    }
    return parseLlmJson(
      res.raw,
      parsed => {
        const scores = toScores(parsed.scores);
        if (scores === null) return null;
        const low = scores.filter(s => typeof s.score === "number" && s.score < GROUNDEDNESS_THRESHOLD);
        const lowNames = low.map(s => String(s.feature ?? "")).filter(Boolean);
        return {
          groundedness_result: JSON.stringify(parsed),
          low_confidence_features: lowNames,
          groundedness_feedback:
            lowNames.length > 0
              ? `低依据特征 ${lowNames.length} 个：${low
                  .map(s => `${String(s.feature)}(${Number(s.score)})`)
                  .join("、")}`
              : "全部特征均有充分原文依据",
        };
      },
      raw => ({ groundedness_result: raw }),
    );
  }
}

/** 单个 groundedness 打分项（LLM JSON 输出形状，经类型守卫收窄）。 */
type GroundednessScore = { feature?: unknown; score?: unknown; reason?: unknown };

/**
 * 收窄 parsed.scores 为打分项数组（集中 LLM 输出形状的 cast 边界）：
 * 非数组返回 null（形状不符，走 parseLlmJson 的 onParseFailure）；数组则过滤非对象元素。
 */
function toScores(value: unknown): GroundednessScore[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((s): s is GroundednessScore => s !== null && typeof s === "object" && !Array.isArray(s));
}
