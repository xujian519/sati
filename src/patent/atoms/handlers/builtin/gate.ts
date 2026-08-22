/**
 * 门控域原子：approval-gate（人机审批门，人工介入中断）+
 * quality-gate（检索质量门槛，确定性）+ slop-gate（反套话评分门，确定性）。
 *
 * 审批闭环（双路径共享同一放行契约）：
 * - 图路径：grantApproval 把放行标记写入检查点 state，resume 重放时本 handler
 *   检测到标记即放行（返回空 delta，不中断）；
 * - manifest 路径（runWorkflow）：宿主按 approvalGrants（stageId 粒度）把标记
 *   注入 handler 执行态，本 handler 同样放行；runWorkflow 仅为放行结果补充
 *   占位输出（APPROVAL_GRANTED_OUTPUT，避免无输出被标记 degraded）。
 * 两条路径的"放行判定"都收敛在本 handler，不分散在外层。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  InterruptStageError,
  getStateArray,
  getStateString,
} from "../../handler.js";
import { checkSearchQuality } from "../../../quality/index.js";
import { buildSlopRevisionHint } from "../../../retry-hints.js";
import { analyzeSlop } from "../../../slop-engine.js";
import { degraded } from "./llm.js";

/** 审批门放行标记键：state 中存在该键（truthy）时审批门直接放行。 */
export const APPROVAL_GRANTED_KEY = "__approval_granted__";

/** 已批准审批门在 manifest 路径的占位输出（图路径无输出概念，不需要）。 */
export const APPROVAL_GRANTED_OUTPUT = "APPROVED";

/**
 * 判断 handler 是否为"人工放行型门"（按 name 契约，供 runWorkflow 注入放行标记）。
 * 放行语义 = 人已批准"继续"（approval-gate：确认产出；clarity-gate：强制跨过
 * 清晰度门槛——语义同构，均走 approveStageIds / grantApproval 契约）。
 */
export function isApprovalGateHandler(handler: StageHandler): boolean {
  return handler.name === "approval-gate" || handler.name === "clarity-gate";
}

export const approvalGateAtom: Atom = {
  name: "approval-gate",
  description: "人机审批门：挂起等待人工确认（返回中断错误，由上层恢复后继续；已批准时放行）",
  category: "gate",
  inputSchema: ["review_context", "guardrail_level"],
  outputSchema: [],
};

export class ApprovalGateHandler implements StageHandler {
  readonly name = "approval-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    // 已批准（grantApproval 写入检查点 state 后 resume，或重跑时注入）：放行不中断。
    if (state[APPROVAL_GRANTED_KEY]) {
      return {};
    }
    const reviewContext = getStateString(state, "review_context") || "该阶段产出需要人工确认";
    const guardrailLevel = getStateString(state, "guardrail_level") || "high";
    throw new InterruptStageError("approval-gate", reviewContext, {
      guardrail_level: guardrailLevel,
      review_context: reviewContext,
    });
  }
}

// ---------------------------------------------------------------------------
// quality-gate —— 检索质量确定性门槛（对齐 prosecution-draft.yaml 检索质量检查）
// ---------------------------------------------------------------------------

export const qualityGateAtom: Atom = {
  name: "quality-gate",
  // 描述语义契约：只描述"审什么"，不出现数字断言（如"≥3 篇/≥2 篇"）。
  // 数字断言是评分器内部实现（HITL 报告面保留），worker 可见面剥离——
  // 对齐隐藏清单纪律，防检索凑数/编造。改动需同步 manifest 阶段描述与
  // tests/patent/drafting-sop.spec.ts 的防回归断言。
  description: "检索质量确定性门槛：对比文件数量与相关度标注充分性、全文覆盖、布尔+IPC 检索式",
  category: "gate",
  inputSchema: ["search_summary", "prior_art"],
  outputSchema: ["quality_report"],
};

/** 序列化 prior_art 文档数组为可读文本（"对比文件 N"条目，供门槛判定与 HITL 展示）。 */
function formatPriorArtDocs(docs: unknown[]): string {
  return docs
    .filter(d => d !== null && typeof d === "object" && !Array.isArray(d))
    .map((d, i) => {
      const doc = d as Record<string, unknown>;
      const title = String(doc.title ?? "未命名");
      const snippet = String(doc.snippet ?? "");
      const url = String(doc.url ?? "");
      return `[对比文件 ${i + 1}] ${title}${url.length > 0 ? ` (${url})` : ""}\n${snippet}`;
    })
    .join("\n\n");
}

export class QualityGateHandler implements StageHandler {
  readonly name = "quality-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const summary = getStateString(state, "search_summary");
    const docs = formatPriorArtDocs(getStateArray(state, "prior_art"));
    const text = [summary, docs].filter(Boolean).join("\n");
    if (text.trim().length === 0) {
      return degraded("quality-gate", "输入为空（state.search_summary / prior_art）");
    }
    const result = checkSearchQuality(text);
    const report = [
      `检索质量门: ${result.passed ? "✅ 通过" : "⚠️ 未通过（挂 HITL 决策：退回重做或人工确认放行）"}`,
      `- 对比文件: ${result.details.docCount} 篇 | 相关度标注: ${result.details.relatednessMarks} 处 | 全文标注: ${result.details.fullTextMarks} 篇 | 布尔检索式: ${result.details.hasBooleanQuery ? "是" : "否"} | IPC 限定: ${result.details.hasIpcLimit ? "是" : "否"}`,
      ...result.failures.map(f => `- ❌ ${f}`),
    ].join("\n");
    return { quality_report: report };
  }
}

// ---------------------------------------------------------------------------
// slop-gate —— 反套话 5 维评分门（复用 slop-engine，总分<35 判需修订）
// ---------------------------------------------------------------------------

export const slopGateAtom: Atom = {
  name: "slop-gate",
  // 描述语义契约：同上——不含"总分<35 判需修订"式数字断言（评分线是评分器
  // 内部实现，HITL 报告面保留；worker 可见面剥离，防为凑分而改写而非改善）。
  description: "反套话质量门：slop-engine 多维度初步评分，输出评分报告与证据型修订提示",
  category: "gate",
  inputSchema: ["report_text", "spec_draft", "claims_draft"],
  outputSchema: ["slop_report", "slop_score"],
};

export class SlopGateHandler implements StageHandler {
  readonly name = "slop-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const text =
      getStateString(state, "report_text") ||
      getStateString(state, "spec_draft") ||
      getStateString(state, "claims_draft");
    if (text.trim().length === 0) {
      return degraded("slop-gate", "输入为空（state.report_text / spec_draft / claims_draft）");
    }
    const analysis = analyzeSlop(text);
    const score = analysis.score;
    const report = [
      // HITL 报告面保留评分数字（真实满分 43，通过线 35；勿以 50 为分母——
      // 与 slop-engine scoreDocument 注释同源）。worker 可见面（retry hint）不含此处数字。
      `反套话评分门: ${score.passed ? "✅ 通过" : "⚠️ 需修订"}（总分 ${score.total}，通过线 35）`,
      `- 直接性 ${score.directness} | 证据性 ${score.evidence} | 节奏 ${score.rhythm} | 务实性 ${score.practicality} | 简洁性 ${score.concision}`,
      `- 短语规则命中: ${analysis.changes.length} 处`,
      ...(score.passed ? [] : ["- 建议: 按 slop-engine 清理结果修订后重跑 slop-gate"]),
    ].join("\n");
    // 证据型修订提示（显式约定：非 outputSchema 键 → 断点回退清理不触及；
    // 专供 draft-spec 重跑时注入 prompt，见 DraftSpecHandler；不含任何分数/通过线断言）。
    // 只在未通过（需修订）时生成——通过时不给"修订意见"，避免语义噪音。
    const segment: PipelineState = { slop_report: report, slop_score: JSON.stringify(score) };
    if (!score.passed) {
      const hint = buildSlopRevisionHint(analysis);
      if (hint !== undefined) segment.slop_revision_hint = hint;
    }
    return segment;
  }
}
