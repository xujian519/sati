/**
 * 内置 Pipeline 原子操作（移植自 Mady agentcore/pipeline_stage_handlers.go 设计）。
 *
 * 五个内置原子：search（检索）/ extract（结构化抽取）/ compare（特征对比）/
 * reasoning（自由推理）/ approval-gate（审批门）。每个原子 = Atom 声明式契约
 * + StageHandler 运行时实现。
 *
 * 降级策略（对齐 Mady）：外部能力（LLM/检索器）缺失或输入不完整时返回
 * `_error` 键而非抛错，由 workflow 标记 degraded —— 跑批安全，不中断整体流程。
 */

import { type Atom } from "../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  InterruptStageError,
  getStateArray,
  getStateString,
} from "../handler.js";

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

/** 返回包含 _error 的降级状态片段。 */
function degraded(atom: string, reason: string): PipelineState {
  return { _error: `[${atom}] ${reason}` };
}

/** 提取状态文本：优先显式键，其次按 stageId 键（workflow 写入），最后拼接关键词。 */
function resolveInputText(state: PipelineState, explicitKeys: string[], keywordsKey: string): string {
  for (const key of explicitKeys) {
    const v = getStateString(state, key);
    if (v.trim().length > 0) return v;
  }
  const keywords = getStateString(state, keywordsKey).trim();
  if (keywords.length > 0) return keywords;
  return "";
}

/** 把 prior_art 数组格式化为可读文本（compare 阶段输入用）。 */
function formatPriorArt(state: PipelineState): string {
  const priorArt = getStateArray(state, "prior_art");
  if (priorArt.length === 0) return "(无现有技术)";
  return priorArt
    .map((doc, i) => {
      const d = (doc ?? {}) as { title?: string; snippet?: string; url?: string };
      return `[${i + 1}] ${d.title ?? "未命名"}${d.url ? ` (${d.url})` : ""}\n${d.snippet ?? ""}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// search —— 检索现有技术
// ---------------------------------------------------------------------------

export const searchAtom: Atom = {
  name: "search",
  description: "按查询条件检索现有技术文献，产出文档列表与摘要",
  category: "search",
  inputSchema: ["query", "keywords", "max_results"],
  // 主输出键（outputSchema[0]）为可读文本 search_summary；prior_art 供后续阶段消费。
  outputSchema: ["search_summary", "prior_art"],
};

export class SearchHandler implements StageHandler {
  readonly name = "search";
  readonly category = "search" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const query = resolveInputText(state, ["query", "search_query"], "keywords");
    if (!provider?.search) {
      return degraded("search", "未配置检索器（provider.search 缺失）");
    }
    if (query.trim().length === 0) {
      return degraded("search", "查询条件为空");
    }
    try {
      const maxResults = Number(getStateString(state, "max_results")) || 5;
      const docs = await provider.search(query, { maxResults });
      const summary =
        docs.length > 0
          ? `检索到 ${docs.length} 篇相关文献（查询: ${query.slice(0, 80)}${query.length > 80 ? "…" : ""}）`
          : `未检索到相关文献（查询: ${query.slice(0, 80)}${query.length > 80 ? "…" : ""}）`;
      return { prior_art: docs, search_summary: summary };
    } catch (err) {
      return degraded("search", `检索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// extract —— 结构化抽取（JSON Schema 约束）
// ---------------------------------------------------------------------------

export const extractAtom: Atom = {
  name: "extract",
  description: "从文本中结构化抽取特征/问题/效果（JSON Schema 约束 LLM 输出）",
  category: "extract",
  inputSchema: ["text", "extraction_type", "domain"],
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
    const text = resolveInputText(state, ["text", "extraction_input"], "");
    if (!provider?.callLLM) {
      return degraded("extract", "未配置 LLM（provider.callLLM 缺失）");
    }
    if (text.trim().length === 0) {
      return degraded("extract", "输入文本为空");
    }
    const extractionType = getStateString(state, "extraction_type") || "技术特征抽取";
    const domain = getStateString(state, "domain") || "专利";
    const prompt = [
      `你是 ${domain} 领域的技术分析助手。任务：${extractionType}。`,
      "请从以下文本中提取结构化结果，严格输出 JSON：",
      "```",
      text.slice(0, 8000),
      "```",
    ].join("\n");
    try {
      const raw = await provider.callLLM(prompt, { jsonSchema: EXTRACT_SCHEMA, temperature: 0 });
      const parsed = tryParseJson(raw);
      if (parsed && Array.isArray(parsed.features)) {
        return {
          extraction_result: raw,
          features: parsed.features,
          problems: Array.isArray(parsed.problems) ? parsed.problems : [],
          effects: Array.isArray(parsed.effects) ? parsed.effects : [],
        };
      }
      // JSON 解析失败：保留原文，后续字段留空（不中断）。
      return { extraction_result: raw };
    } catch (err) {
      return degraded("extract", `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

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
    if (!provider?.callLLM) {
      return degraded("compare", "未配置 LLM（provider.callLLM 缺失）");
    }
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
    try {
      const raw = await provider.callLLM(prompt, { jsonSchema: COMPARE_SCHEMA, temperature: 0 });
      const parsed = tryParseJson(raw);
      if (parsed && Array.isArray(parsed.claim_chart)) {
        return {
          claim_chart: parsed.claim_chart,
          diff_features: Array.isArray(parsed.diff_features) ? parsed.diff_features : [],
        };
      }
      return { claim_chart: raw };
    } catch (err) {
      return degraded("compare", `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

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
    if (!provider?.callLLM) {
      return degraded("reasoning", "未配置 LLM（provider.callLLM 缺失）");
    }
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
    try {
      const output = await provider.callLLM(prompt, { temperature: 0.2 });
      return { reasoning_output: output, conclusion: output };
    } catch (err) {
      return degraded("reasoning", `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
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
// approval-gate —— 审批门（人工介入中断）
// ---------------------------------------------------------------------------

export const approvalGateAtom: Atom = {
  name: "approval-gate",
  description: "人机审批门：挂起等待人工确认（返回中断错误，由上层恢复后继续）",
  category: "gate",
  inputSchema: ["review_context", "guardrail_level"],
  outputSchema: [],
};

export class ApprovalGateHandler implements StageHandler {
  readonly name = "approval-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const reviewContext = getStateString(state, "review_context") || "该阶段产出需要人工确认";
    const guardrailLevel = getStateString(state, "guardrail_level") || "high";
    throw new InterruptStageError("approval-gate", reviewContext, {
      guardrail_level: guardrailLevel,
      review_context: reviewContext,
    });
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function tryParseJson(raw: string): Record<string, unknown> | undefined {
  const candidates = [raw, stripCodeFence(raw)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

/** 去掉 ```json ... ``` 围栏（LLM 输出格式漂移兜底）。 */
function stripCodeFence(raw: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return m ? m[1].trim() : raw;
}
