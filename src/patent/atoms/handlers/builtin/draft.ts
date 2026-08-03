/**
 * 撰写域原子：draft-claims（基于 PFE 与新颖性结果直出权利要求草稿）。
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

export const draftClaimsAtom: Atom = {
  name: "draft-claims",
  description: "基于 PFE 与新颖性结果直出权利要求草稿（独立+从属）",
  category: "extract",
  inputSchema: ["pfe_triples", "merge_result", "novelty_conclusion", "source_text"],
  outputSchema: ["claims_draft", "draft_claims_result"],
};

const DRAFT_CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: { type: "array", items: { type: "string" }, description: "权利要求逐条文本" },
    notes: { type: "string", description: "撰写说明（保护范围/布局建议）" },
  },
  required: ["claims"],
} as const;

export class DraftClaimsHandler implements StageHandler {
  readonly name = "draft-claims";
  readonly category = "extract" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "draft-claims");
    if (missing) return missing;
    const mergeResult = getStateString(state, "merge_result");
    const pfeTriples = getStateArray(state, "pfe_triples");
    const novelty = getStateString(state, "novelty_conclusion");
    const source = getStateString(state, "source_text");
    const input = mergeResult || (pfeTriples.length > 0 ? JSON.stringify(pfeTriples, null, 2) : "") || source;
    if (input.trim().length === 0) {
      return degraded("draft-claims", "输入为空（state.merge_result / pfe_triples / source_text）");
    }
    const prompt = [
      "你是专利权利要求撰写专家。基于以下技术交底书分析结果，撰写权利要求书草稿。",
      "要求：",
      "- 独立权利要求包含解决技术问题的全部必要技术特征",
      "- 从属权利要求对独立权利要求做细化限定（结构/参数/方法步骤）",
      "- 权利要求清楚、简要，避免含义不确定的术语",
      "- 避免过宽的功能性限定；功能性限定以说明书公开的实施方式为限",
      "- 与新颖性分析结论一致：区别特征应体现在独立权利要求中",
      "",
      "【分析结果】",
      "```",
      input.slice(0, 8000),
      "```",
      novelty.trim().length > 0 ? `【新颖性结论】\n${novelty.slice(0, 2000)}` : "",
      "",
      "请严格输出 JSON：claims 为权利要求逐条文本数组（第 1 条为独立权利要求），notes 为撰写说明。",
    ].join("\n");
    const res = await callLlm(provider, "draft-claims", prompt, { schema: DRAFT_CLAIMS_SCHEMA, temperature: 0.2 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      (parsed, raw) => {
        if (!Array.isArray(parsed.claims)) return null;
        return {
          claims_draft: parsed.claims.map(String).join("\n\n"),
          draft_claims_result: raw,
        };
      },
      raw => ({ claims_draft: raw }),
    );
  }
}
