/**
 * 无效/复审域原子：证据模式的新颖性/创造性执行。
 *
 * 与 `patent_workflow_run({ graph: ... })` 的区别只有一处：图以
 * `evidence: "supplied"` 构建，不插检索节点。证据来自上游 claim-chart 的
 * `targets` 与 `rows`（请求人指定的对比文件），不能被新的检索结果替换。
 *
 * 图构建函数用动态 import：`graph/domains` 依赖 `atoms/index` 的全局注册表，
 * 顶层互相 import 会形成循环；执行时才加载，模块已完整求值。
 */

import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import type { StageProvider } from "../../handler.js";

/** 无证据目标时的固定说明。 */
export const NO_EVIDENCE_REASON = "未提供证据目标，已拒绝改为自行检索";

export type InvalidityAnalysis = "novelty" | "inventiveness";

export const invalidityAnalysisAtom: Atom = {
  name: "invalidity-analysis",
  description: "用对照表里请求人指定的证据执行新颖性/创造性分析（证据模式，不自行检索）",
  category: "compare",
  inputSchema: ["claim_chart_doc", "analysis", "text"],
  outputSchema: ["invalidity_report"],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // claim-chart 缺失或损坏时按空证据处理，由调用方返回「拒绝自行检索」。
    return undefined;
  }
}

function readAnalysis(state: PipelineState): InvalidityAnalysis {
  return getStateString(state, "analysis") === "novelty" ? "novelty" : "inventiveness";
}

type EvidenceTarget = {
  id: string;
  title?: string;
  sourcePath?: string;
  quote: string;
  pinCite: string;
};

function readEvidence(state: PipelineState): { targets: EvidenceTarget[]; claim: string } {
  const chart = asRecord(parseJson(getStateString(state, "claim_chart_doc")));
  const rawTargets = Array.isArray(chart?.targets) ? chart.targets : [];
  const rawRows = Array.isArray(chart?.rows) ? chart.rows : [];

  const targets = rawTargets
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map(item => {
      const id = typeof item.id === "string" ? item.id : "";
      const rows = rawRows
        .map(row => asRecord(row))
        .filter((row): row is Record<string, unknown> => row !== undefined && row.targetId === id);
      return {
        id,
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.sourcePath === "string" ? { sourcePath: item.sourcePath } : {}),
        quote: rows
          .map(row => (typeof row.quote === "string" ? row.quote : ""))
          .filter(Boolean)
          .join("\n"),
        pinCite: rows
          .map(row => (typeof row.pinCite === "string" ? row.pinCite : ""))
          .filter(Boolean)
          .join("；"),
      };
    })
    .filter(target => target.id.length > 0);

  const claim = typeof chart?.claim === "string" ? chart.claim : getStateString(state, "text");
  return { targets, claim };
}

function toPriorArt(targets: readonly EvidenceTarget[]): Array<Record<string, string>> {
  return targets.map(target => ({
    title: target.title ?? target.id,
    id: target.id,
    snippet: [target.quote, target.pinCite].filter(Boolean).join(" | "),
    ...(target.sourcePath !== undefined ? { url: target.sourcePath } : {}),
  }));
}

export class InvalidityAnalysisHandler implements StageHandler {
  readonly name = "invalidity-analysis";
  readonly category = "compare" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const analysis = readAnalysis(state);
    const { targets, claim } = readEvidence(state);

    if (targets.length === 0) {
      return {
        invalidity_report: JSON.stringify({
          analysis,
          status: "degraded_no_evidence",
          reason: NO_EVIDENCE_REASON,
          targetIds: [],
          nodes: [],
        }),
      };
    }

    const { buildInventivenessGraph, buildNoveltyGraph } = await import("../../../graph/domains/index.js");
    const builder =
      analysis === "novelty"
        ? buildNoveltyGraph({ evidence: "supplied", includeApproval: false, ruleGate: false })
        : buildInventivenessGraph({ evidence: "supplied", includeApproval: false, ruleGate: false });
    const compiled = builder.compile(analysis === "novelty" ? "extract" : "parse");

    const seed: Record<string, unknown> = {
      text: claim,
      claim,
      prior_art: toPriorArt(targets),
    };
    const result = await compiled.run(seed, { provider: provider as StageProvider | undefined });

    const reportKey = analysis === "novelty" ? "novelty_report" : "inventiveness_conclusion";
    const report = getStateString(result.state, reportKey);
    const evidenceWithoutQuote = targets.filter(target => target.quote.trim().length === 0).map(target => target.id);

    return {
      invalidity_report: JSON.stringify({
        analysis,
        status: report.trim().length > 0 ? "completed" : "degraded_no_report",
        report,
        targetIds: targets.map(target => target.id),
        evidenceWithoutQuote,
        nodes: (result.nodeDurations ?? []).map(duration => duration.node),
        completed: result.completed,
        degraded: result.degraded.map(mark => mark.reason),
      }),
    };
  }
}
