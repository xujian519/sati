/**
 * claim-breadth 原子 —— A26.4 权利要求支持/清楚判定（#830 M2）。
 *
 * 包装 `claim-breadth` 领域子图（graph/domains/claim-breadth.ts），使 A26.4
 * 判定可作为起草管线的**阶段**执行——与 A26.3 enablement 子图对称。
 *
 * 与 `invalidity-analysis` 原子同范式：原子内部跑图，产出报告 + 结构化结论。
 * 审批门不启用（`includeApproval: false`）：起草管线已有 HITL 审批门，
 * 子图内再插一个审批门会造成双重挂起（issue「明确不做」第 6 条）。
 *
 * 降级不静默：LLM 不可用或结论不可解析时显式标记 degraded，不冒充通过。
 */

import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";

export const claimBreadthAtom: Atom = {
  name: "claim-breadth",
  description: "A26.4 权利要求支持/清楚判定：锚点证据 + 清楚/支持/功能性限定三步审查",
  category: "reason",
  inputSchema: ["claims_draft", "claims_strategy", "source_text", "spec_draft"],
  // 主输出键必须是 outputSchema[0]（workflow 以此取阶段主输出，见 workflow/executor.ts）。
  outputSchema: [
    "claim_breadth_report",
    "claim_breadth_result",
    "claim_breadth_preview_report",
    "claim_breadth_preview_result",
  ],
};

export class ClaimBreadthHandler implements StageHandler {
  readonly name = "claim-breadth";
  readonly category = "reason" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    // 两阶段接线（#830 T2.9）：
    // - 交底阶段预评估：state 无 claims_draft，读 claim_strategy 的建议特征
    //   （"建议权要特征"），产出预评估结论，键前缀 claim_breadth_preview_*；
    // - 草稿阶段复核：state 有 claims_draft，对实际权要草稿做正式 A26.4 复核，
    //   键前缀 claim_breadth_*。
    // 权项文本：优先草稿权要，缺省回退策略表建议特征（预评估）。
    const claims = getStateString(state, "claims_draft");
    const preview = claims.trim().length === 0 ? readStrategyFeatures(state) : "";
    const spec = getStateString(state, "spec_draft") || getStateString(state, "source_text");
    if (claims.trim().length === 0 && preview.trim().length === 0 && spec.trim().length === 0) {
      return {
        claim_breadth_report: "A26.4 判定: ⚠️ 未执行（无权要文本与说明书原文可判）",
        claim_breadth_result: JSON.stringify({
          status: "degraded_no_input",
          supportOk: undefined,
          clarityOk: undefined,
          gaps: [],
        }),
      };
    }
    const isPreview = claims.trim().length === 0;
    const claimText = isPreview ? preview : claims;

    const { buildClaimBreadthGraph, extractClaimBreadthResult } = await import("../../../graph/domains/index.js");
    const compiled = buildClaimBreadthGraph({ includeApproval: false, ruleGate: false }).compile("load");

    const result = await compiled.run(
      {
        claim: claimText,
        claims: claimText,
        spec,
        text: spec,
        source_text: spec,
      },
      { ...(provider !== undefined ? { provider } : {}) },
    );

    const breadth = extractClaimBreadthResult(result.state);
    const degraded = result.degraded.map(mark => mark.reason);
    // 结论缺失（LLM 不可用/输出不可解析）不得冒充通过：supportOk/clarityOk 保持 undefined。
    const assessed = breadth.supportOk !== undefined || breadth.clarityOk !== undefined;
    const phaseLabel = isPreview ? "交底阶段预评估" : "草稿阶段复核";
    const report = [
      `A26.4 判定（${phaseLabel}）: ${assessed ? (breadth.supportOk && breadth.clarityOk ? "✅ 通过" : "⚠️ 存在缺陷") : "⚠️ 未评估"}`,
      ...(breadth.supportOk !== undefined ? [`- 以说明书为依据: ${breadth.supportOk ? "是" : "否"}`] : []),
      ...(breadth.clarityOk !== undefined ? [`- 权利要求清楚: ${breadth.clarityOk ? "是" : "否"}`] : []),
      ...(breadth.gaps ?? []).map(gap => `- 缺陷: ${gap}`),
      ...(degraded.length > 0 ? [`- 降级: ${degraded.join("；")}`] : []),
      ...(breadth.report ? ["", breadth.report] : []),
    ].join("\n");

    const payload = JSON.stringify({
      status: assessed ? "completed" : "degraded_no_conclusion",
      phase: isPreview ? "preview" : "review",
      supportOk: breadth.supportOk,
      clarityOk: breadth.clarityOk,
      gaps: breadth.gaps ?? [],
      confidence: breadth.confidence,
      degraded,
    });

    // 主输出键恒为 outputSchema[0]（workflow 取 outputSchema[0] 为主输出，
    // 见 workflow/executor.ts）→ 两阶段都写 claim_breadth_report/result；
    // 预览阶段额外写 preview 键留存预评估结论（复核阶段不覆盖它）。
    // 预览/复核的区分放在 payload.phase 与报告标题里，不靠换主键。
    return isPreview
      ? {
          claim_breadth_report: report,
          claim_breadth_result: payload,
          claim_breadth_preview_report: report,
          claim_breadth_preview_result: payload,
        }
      : {
          claim_breadth_report: report,
          claim_breadth_result: payload,
        };
  }
}

/**
 * 从策略表读建议权要特征（交底阶段预评估用）。
 *
 * 策略表结构：{ subject, independent_features[], dependent_claims[] }。此处只取
 * 独立权项特征 + 从权特征，渲染为「其特征在于」式候选权项文本供子图判定。
 */
function readStrategyFeatures(state: PipelineState): string {
  const raw = getStateString(state, "claims_strategy");
  if (raw.trim().length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 策略表不可解析：无建议特征可用 → 预评估阶段拿不到权项文本，
    // 由调用方走「无输入」显式降级路径（不静默当作空特征集继续判定）。
    return "";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const record = parsed as {
    subject?: unknown;
    independent_features?: unknown;
    dependent_claims?: unknown;
  };
  const subject = typeof record.subject === "string" ? record.subject : "一种发明";
  const independent = Array.isArray(record.independent_features) ? record.independent_features.map(String) : [];
  const dependent = Array.isArray(record.dependent_claims) ? record.dependent_claims : [];
  const lines: string[] = [`1. ${subject}，其特征在于：${independent.join("，")}。`];
  let claimNo = 2;
  for (const entry of dependent) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const dep = entry as { depends_on?: unknown; features?: unknown };
    const dependsOn = Array.isArray(dep.depends_on) ? dep.depends_on.map(String).join("或") : "1";
    const features = Array.isArray(dep.features) ? dep.features.map(String) : [];
    if (features.length === 0) continue;
    lines.push(`${claimNo}. 根据权利要求${dependsOn}所述的${subject}，其特征在于：${features.join("，")}。`);
    claimNo += 1;
  }
  return lines.join("\n");
}
