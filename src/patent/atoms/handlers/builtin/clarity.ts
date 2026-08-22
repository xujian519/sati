/**
 * 清晰度门原子：clarity-gate（交底书清晰度准入评分，语义层 + HITL 门）。
 *
 * 语义（对齐 Ouroboros 的"输入清晰度门"思想，与第一刀隐藏清单互补）：
 * - 机械层：四维结构信号（确定性，见 src/patent/clarity/signals.ts）
 * - 语义层：LLM 四维打分（temperature 0.1 对齐 Ouroboros 可复现性；机械信号
 *   作为证据注入 prompt —— LLM 看到的不是"门槛"，是"文档里实际有什么"）
 * - 融合：clarity_i = 0.75×LLM + 0.25×signal；Ambiguity = 1 - Σ(clarity_i×w_i)
 * - 门：ambiguity > 0.2 → InterruptStageError 挂 HITL（1=确认继续(强制放行) /
 *   2=补充交底书 / 3=退回）；已批准（APPROVAL_GRANTED_KEY 注入，语义 = 强制
 *   放行）→ 报告尾部标记 FORCED 继续，不中断。
 *
 * 降级语义（fail-open 带警告）：LLM 不可用/失败时退化为纯机械评分
 * （semanticOnly 标记 + degraded），不阻塞管线（收口/无 LLM 环境可跑）；
 * 机械信号缺失是客观事实，报告如实标注。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  InterruptStageError,
  getStateString,
} from "../../handler.js";
import {
  CLARITY_THRESHOLD,
  computeClarityScore,
  detectClaritySignals,
  formatSignalsForPrompt,
  type ClarityDimensionKey,
  type ClaritySignal,
  type ClarityScore,
} from "../../../clarity/index.js";
import { APPROVAL_GRANTED_KEY } from "./gate.js";
import { callLlm, degraded, parseLlmJson, requireLlm } from "./llm.js";

export const clarityGateAtom: Atom = {
  name: "clarity-gate",
  // 描述语义契约：声明"审什么"与"门槛语义"，不含具体阈值数字（0.2 是评分器
  // 内部默认值，HITL 报告面保留阈值展示；对齐隐藏清单章节的描述面纪律）。
  description: "交底书清晰度准入门：四维量化（问题/方案/效果/实施）不足时挂 HITL 决策",
  category: "gate",
  inputSchema: ["source_text", "text", "input"],
  outputSchema: ["clarity_report", "clarity_score"],
};

/** 语义层打分 JSON Schema（四维 0-1 + 理由）。 */
const CLARITY_SCHEMA = {
  type: "object",
  properties: {
    problem: { type: "number", description: "技术问题清晰度 0-1" },
    solution: { type: "number", description: "技术方案清晰度 0-1" },
    effect: { type: "number", description: "技术效果可测性 0-1" },
    enablement: { type: "number", description: "实施充分度 0-1" },
    reasons: {
      type: "object",
      properties: {
        problem: { type: "string", description: "给分理由（引用交底书证据）" },
        solution: { type: "string", description: "给分理由（引用交底书证据）" },
        effect: { type: "string", description: "给分理由（引用交底书证据）" },
        enablement: { type: "string", description: "给分理由（引用交底书证据）" },
      },
    },
  },
  required: ["problem", "solution", "effect", "enablement"],
} as const;

/** 语义分解析（0-1 收窄；非数字键忽略，不抛错）。 */
function parseSemanticScores(raw: string): {
  semantic: Partial<Record<ClarityDimensionKey, number>>;
  reasons: Partial<Record<ClarityDimensionKey, string>>;
} {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const semantic: Partial<Record<ClarityDimensionKey, number>> = {};
  const reasons: Partial<Record<ClarityDimensionKey, string>> = {};
  for (const key of ["problem", "solution", "effect", "enablement"] as const) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      semantic[key] = Math.min(1, Math.max(0, value));
    }
    const reason = (parsed.reasons as Record<string, unknown> | undefined)?.[key];
    if (typeof reason === "string" && reason.trim().length > 0) reasons[key] = reason.trim();
  }
  return { semantic, reasons };
}

/** 渲染清晰度报告（HITL 面保留阈值/分数数值；数值面与描述面分层的原则不变）。 */
export function renderClarityReport(score: ClarityScore, signals: readonly ClaritySignal[], forced: boolean): string {
  const lines = [
    `交底书清晰度门: ${score.passed ? "✅ 通过" : "⚠️ 未达门槛"}（清晰度 ${score.clarity}，模糊度 ${score.ambiguity}，门槛 ≤${CLARITY_THRESHOLD}）${score.semanticOnly ? "【仅机械层：语义 LLM 不可用】" : ""}${forced ? "【人工强制放行】" : ""}`,
    `- 最弱维度: ${score.weakest.label}（${score.weakest.score}，权重 ${score.weakest.weight}）`,
  ];
  for (const d of score.dimensions) {
    const sig = signals.find(s => s.key === d.key);
    const evidence = sig?.present
      ? (sig.evidence ?? []).map(e => `    · ${e}`).join("\n")
      : `    · ${sig?.missingHint ?? "缺乏该维度表述"}`;
    lines.push(
      `- ${d.label}: 语义 ${d.semantic} | 信号 ${d.signal} | 融合 ${d.score}（权重 ${d.weight}）${d.reason !== undefined ? `\n    理由: ${d.reason}` : ""}\n${evidence}`,
    );
  }
  lines.push(
    score.passed
      ? "- 结论: 交底书满足清晰度门槛，可进入解构/提取。"
      : "- 结论: 建议补充交底书后重跑（补充方向：最弱维度；如需强行推进请在 HITL 确认继续）。",
  );
  return lines.join("\n");
}

export class ClarityGateHandler implements StageHandler {
  readonly name = "clarity-gate";
  readonly category = "gate" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const text =
      getStateString(state, "source_text") || getStateString(state, "text") || getStateString(state, "input");
    if (text.trim().length === 0) {
      return degraded("clarity-gate", "输入为空（state.source_text / text / input）");
    }
    const signals = detectClaritySignals(text);

    // 语义层（LLM）：不可用 → 降级纯机械评分（semanticOnly + fail-open 说明，不中断）。
    // 与 groundedness 的 fail-open 惯例一致：主输出键有值（报告自述降级），
    // 不提供 _error 键（runStageOnce 的 degraded 判定看主输出键缺失而非 _error）。
    const missing = requireLlm(provider, "clarity-gate");
    if (missing) {
      const score = computeClarityScore(undefined, signals);
      return {
        clarity_report: renderClarityReport(score, signals, false),
        clarity_score: JSON.stringify(score),
      };
    }

    const prompt = [
      "你是专利交底书质量评估专家。对以下技术交底书逐一评分（0-1），四维：",
      "- problem 技术问题清晰：要解决的问题是否明确具体（不模糊/不空泛）",
      "- solution 技术方案清晰：解决手段是否完整可实施（结构/工艺/方法步骤）",
      "- effect 技术效果可测：效果是否可验证（有定量预期/对比基准）",
      "- enablement 实施充分：是否给出实施例/参数/附图等实施细节",
      "",
      "【机械信号（已确定性检测到的结构证据，供你引用与校准）】",
      formatSignalsForPrompt(signals),
      "",
      "【技术交底书】",
      "```",
      text.slice(0, 8000),
      "```",
      "",
      "请严格输出 JSON：problem/solution/effect/enablement 为 0-1 分数，reasons 为各维给分理由（引用交底书原文）。",
    ].join("\n");

    const res = await callLlm(provider, "clarity-gate", prompt, { schema: CLARITY_SCHEMA, temperature: 0.1 });
    if (!res.ok) {
      // 语义层失败：fail-open 带警告退化为纯机械层（不中断管线）。
      const score = computeClarityScore(undefined, signals);
      return {
        clarity_report: `[clarity-gate] 语义层不可用（${res.message}），以下为仅机械层评估：\n${renderClarityReport(score, signals, false)}`,
        clarity_score: JSON.stringify(score),
      };
    }

    const parsed = parseLlmJson(
      res.raw,
      (_parsed, raw) => {
        const { semantic, reasons } = parseSemanticScores(raw);
        const score = computeClarityScore(semantic, signals, reasons);
        return { clarity_score: JSON.stringify(score), semantic_scores: raw };
      },
      () => {
        // JSON 解析失败：退化为纯机械层（报告自述降级）。
        const score = computeClarityScore(undefined, signals);
        return {
          clarity_report: `[clarity-gate] 语义层输出不可解析，以下为仅机械层评估：\n${renderClarityReport(score, signals, false)}`,
          clarity_score: JSON.stringify(score),
        };
      },
    );
    const rawScore = String(parsed.clarity_score);
    const score = JSON.parse(rawScore) as ClarityScore;
    const forced = Boolean(state[APPROVAL_GRANTED_KEY]);
    const report = renderClarityReport(score, signals, forced);

    // 门：未过且未获人工强制放行 → 中断挂 HITL；已放行/通过 → 继续。
    if (!score.passed && !forced) {
      throw new InterruptStageError("clarity-gate", "交底书清晰度未达门槛，请决策继续/补充或退回", {
        guardrail_level: "medium",
        review_context: `交底书清晰度不足（模糊度 ${score.ambiguity} > 门槛 ${CLARITY_THRESHOLD}）。编号选择：1=确认继续（强制放行） / 2=补充交底书后重跑 / 3=退回`,
        clarity_report: report,
        clarity_score: rawScore,
      });
    }
    return { clarity_report: report, clarity_score: rawScore };
  }
}
