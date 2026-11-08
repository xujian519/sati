/**
 * claim-lint 原子 —— 权要文本确定性校验门（#830 M4）。
 *
 * 纯函数、零 LLM、零 I/O：读 state.claims_draft，调用 `claim-lint` 规则引擎，
 * 输出结构化校验结果。
 *
 * 契约要点：
 * - 输出为严格 JSON，含 `gaps[]` / `consistent` 字段 → 直接对接 workflow 的
 *   结构化回退判据（`retry.whenOutputGaps`），error 非空即回退 draft_claims。
 * - `consistent:false` 语义 = 存在 error 级问题（warning 不阻断）。
 * - 修订提示走独立键 `claim_lint_revision_hint`（非 outputSchema 键，
 *   断点回退清理不触及），供 draft-claims 重跑时注入；只含问题定位与建议，
 *   不含任何"通过线"式数字断言。
 */

import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import { lintClaimText, type ClaimLintIssue } from "../../../claim-lint/index.js";

export const claimLintAtom: Atom = {
  name: "claim-lint",
  // 描述语义契约：不含"零 error 才放行"式的门限数字断言（判定口径是 lint
  // 引擎内部实现，HITL 报告面保留；worker 可见面剥离，防为凑分而改写）。
  description: "权利要求确定性校验门：术语清楚/引用基础/多项引用/前序一致/功能限定/编号连续六条规则",
  category: "gate",
  inputSchema: ["claims_draft", "claims_tree"],
  outputSchema: ["claim_lint_report", "claim_lint_result"],
};

/** 每条 hint 证据清单的条目上限（防提示过长挤占上下文）。 */
const MAX_HINT_ISSUES = 6;

/**
 * 证据型修订提示：只给「哪条权项、命中哪条规则、问题原文、怎么改」，
 * 不含任何通过线或计数断言（对齐 retry-hints 的断言安全契约）。
 */
export function buildClaimLintRevisionHint(issues: readonly ClaimLintIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const lines: string[] = ["- 上一轮权利要求校验发现以下问题（请针对问题逐条修订）："];
  for (const issue of issues.slice(0, MAX_HINT_ISSUES)) {
    const where = issue.claimNo !== undefined ? `第 ${issue.claimNo} 条` : "权项";
    lines.push(`  · ${where}［${issue.rule}］${issue.message} → ${issue.hint}`);
  }
  const residual = issues.length - Math.min(issues.length, MAX_HINT_ISSUES);
  if (residual > 0) lines.push(`  · 另有 ${residual} 条同类问题未列出`);
  return lines.join("\n");
}

/** 单条问题的中文标签（报告面可读）。 */
const RULE_LABELS: Record<ClaimLintIssue["rule"], string> = {
  "uncertain-term": "术语清楚",
  "reference-basis": "引用基础",
  "multiple-dependent-basis": "多项引用",
  "antecedent-consistency": "前序一致",
  "functional-limitation": "功能限定",
  "numbering-continuity": "编号连续",
};

export class ClaimLintHandler implements StageHandler {
  readonly name = "claim-lint";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const claims = getStateString(state, "claims_draft");
    if (claims.trim().length === 0) {
      // 无权要文本：不是"通过"，是"无法校验"——显式降级，不静默放行。
      return {
        claim_lint_report: "权要校验门: ⚠️ 未执行（无权利要求文本可校验）",
        claim_lint_result: JSON.stringify({
          consistent: false,
          gaps: [{ id: "no-claims", message: "无权利要求文本可校验" }],
          passed: false,
          errorCount: 0,
          warningCount: 0,
          degraded: true,
        }),
      };
    }

    const result = lintClaimText(claims);
    const report = [
      `权要校验门: ${result.passed ? "✅ 通过" : "⚠️ 未通过"}（error ${result.errors.length} 项 / warning ${result.warnings.length} 项）`,
      ...result.errors.map(issue => `- ❌ [${RULE_LABELS[issue.rule]}] ${issue.message}`),
      ...result.warnings.map(issue => `- ⚠️ [${RULE_LABELS[issue.rule]}] ${issue.message}`),
      ...(result.passed ? [] : ["- 建议: 按上列问题修订权利要求后重跑"]),
    ].join("\n");

    const segment: PipelineState = {
      claim_lint_report: report,
      claim_lint_result: JSON.stringify({
        // 结构化回退判据：error 非空 → gaps 非空 → consistent:false。
        consistent: result.passed,
        gaps: result.errors.map(issue => ({
          id: `${issue.rule}${issue.claimNo !== undefined ? `:${issue.claimNo}` : ""}`,
          message: issue.message,
          hint: issue.hint,
        })),
        passed: result.passed,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
        degraded: false,
      }),
    };
    // 证据型修订提示（显式约定：非 outputSchema 键 → 断点回退清理不触及；
    // 专供 draft-claims 重跑时注入 prompt）。只在存在 error 时生成。
    if (!result.passed) {
      const hint = buildClaimLintRevisionHint(result.errors);
      if (hint !== undefined) segment.claim_lint_revision_hint = hint;
    }
    return segment;
  }
}
