import {
  buildVerdictEnvelope,
  collectJudgeVotes,
  llmJudge,
  renderConsensusText,
  resolveConsensus,
} from "../../../patent/index.js";
import type { StageProvider } from "../../../patent/atoms/index.js";
import type { PatentWorkflowRunDeps, PatentWorkflowRunInput } from "./types.js";

/** 图模式 judge 装配（消费 judgeModels → deps.modelHints；缺省单 judge 走默认模型）。 */
export function assembleGraphJudges(input: PatentWorkflowRunInput, deps: PatentWorkflowRunDeps): NamedJudgeInput[] {
  const hints = input.judgeModels ?? [];
  // 无共识配置：单 judge（默认模型）——采样数由调用方控制（judgeSamples）。
  if (hints.length === 0) {
    return [{ judgeId: "default" }];
  }
  return hints.map(hint => {
    const mapped = deps.modelHints?.[hint];
    return {
      judgeId: `judge:${hint}`,
      ...(mapped?.provider !== undefined ? { provider: mapped.provider } : {}),
      ...(mapped?.model !== undefined ? { model: mapped.model } : {}),
      modelHint: hint,
    };
  });
}

/** judge 输入形状（callLLM 由 buildJudgeSection 依 provider + modelHint 注入）。 */
export type NamedJudgeInput = {
  judgeId: string;
  provider?: string;
  model?: string;
  modelHint?: string;
};

export type JudgeSectionOptions = {
  graphName: string;
  /** 题目（graph 输入）。 */
  input: string;
  /** 结论报告（conclude 节点产物）。 */
  report: string;
  /** 机械层判级（rule_gate_verdict）。 */
  ruleGateVerdict: string;
  /** 机械层检查域。 */
  ruleGateDomains: string[];
  /** 已装配 judge（含 modelHint；callLLM 由本函数按 provider 注入）。 */
  judges: NamedJudgeInput[];
  /** 每 judge 采样数。 */
  samples: number;
  /** judgeSamples 单模型兼容路径的采样数（>0 且无 judgeModels 时生效）。 */
  singleModelFallback: number;
  /** 是否中断（中断时不评估）。 */
  interrupted: boolean;
  /** LLM 通道（judge 调用经 provider.callLLM，modelHint 透传 per-node 覆盖）。 */
  provider: StageProvider | undefined;
};

/**
 * 构建图模式判分段落：judgeModels 多模型共识（votes → consensus → envelope）
 * 或 judgeSamples 单模型采样（向后兼容文本）。纯逻辑可单测（注入 mock judge）。
 */
export async function buildJudgeSection(opts: JudgeSectionOptions): Promise<string> {
  if (opts.interrupted) return "";
  const report = opts.report;
  if (report.trim().length === 0) return "\n🧭 评估：无结论报告（结论节点降级），跳过评分";
  if (opts.provider?.callLLM === undefined) return "\n🧭 评估：无 LLM 通道，跳过评分";
  const multimodel = opts.judges.some(j => j.modelHint !== undefined) || opts.judges.length > 1;
  if (!multimodel && opts.singleModelFallback <= 0) return "";

  if (multimodel) {
    // 多模型共识链：各 judge 经 provider.callLLM + modelHint（宿主 modelHints 映射 provider/model）。
    const votes = await collectJudgeVotes(
      opts.judges.map(j => ({
        judgeId: j.judgeId,
        ...(j.provider !== undefined ? { provider: j.provider } : {}),
        ...(j.model !== undefined ? { model: j.model } : {}),
        callLLM: (prompt, callOpts) =>
          opts.provider!.callLLM!(prompt, {
            ...callOpts,
            ...(j.modelHint !== undefined ? { modelHint: j.modelHint } : {}),
          }),
      })),
      opts.input,
      report,
      undefined,
      { samples: opts.samples, temperature: 0 },
    );
    if (votes.length === 0) return "\n🧭 共识判定：全部 judge 评分失败（跳过）";
    const verdict = resolveConsensus(votes);
    if (verdict === undefined) return "\n🧭 共识判定：无可判定票（跳过）";
    const envelope = buildVerdictEnvelope({
      artifact: report.slice(0, 120),
      artifactType: `graph:${opts.graphName}/conclusion`,
      layers: [
        {
          layer: "mechanical",
          label: "确定性规则门",
          verdict: opts.ruleGateVerdict,
          detail: `规则门判级：${opts.ruleGateVerdict}（域：${opts.ruleGateDomains.join(", ") || "未知"}），不因共识改变。`,
          participants: [...opts.ruleGateDomains],
          at: new Date().toISOString(),
        },
        {
          layer: "semantic",
          label: "LLM Judge 多模型打分",
          verdict: votes.map(v => v.score.toFixed(2)).join(" / "),
          detail: `共 ${votes.length} 票：${votes.map(v => `${v.judgeId} ${v.score.toFixed(2)}`).join("；")}`,
          participants: votes.map(v => v.judgeId),
          at: new Date().toISOString(),
        },
        {
          layer: "consensus",
          label: "共识判定",
          verdict: verdict.verdict,
          detail: `中位 ${verdict.median.toFixed(3)}（阈值 ${verdict.threshold}），极差 ${verdict.spread.toFixed(3)}`,
          participants: [],
          at: new Date().toISOString(),
        },
      ],
    });
    return `\n${renderConsensusText(verdict)}\n🔏 Verdict Envelope: overall=${envelope.overall} | hash=${envelope.hash.slice(0, 16)}…`;
  }

  // 单模型路径（向后兼容：judgeSamples）。
  const score = await llmJudge(
    { callLLM: (prompt, callOpts) => opts.provider!.callLLM!(prompt, callOpts) },
    opts.input,
    report,
    undefined,
    { samples: opts.singleModelFallback, temperature: 0 },
  );
  return score !== undefined
    ? `\n🧭 LLM Judge 质量分（双轨参考，不影响规则门判级）: ${score.toFixed(3)}`
    : "\n🧭 LLM Judge：评分失败（采样解析异常）";
}
