/**
 * procedure-checklist 原子：把程序核验清单接进无效/复审 manifest。
 *
 * 期限条目由上游以 `deadline_entries`（JSON 数组）传入；未提供时清单标
 * 「未求值」，不自行推算日期。
 */

import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import {
  buildProcedureChecklist,
  type ProcedureDeadlineEntry,
  type ProcedureKind,
} from "../../../procedure/checklist.js";

export const procedureChecklistAtom: Atom = {
  name: "procedure-checklist",
  description: "核对复审/无效的程序事项与理由-证据对应关系（核验表，不是请求书）",
  category: "gate",
  inputSchema: ["text", "claim_chart_doc", "procedure_kind", "deadline_entries"],
  outputSchema: ["procedure_checklist"],
};

function readDeadlines(raw: string): ProcedureDeadlineEntry[] | undefined {
  if (raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .map(item => (typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map(item => ({
        id: typeof item.id === "string" ? item.id : "",
        ...(typeof item.status === "string" ? { status: item.status } : {}),
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
        ...(typeof item.date === "string" ? { date: item.date } : {}),
      }))
      .filter(item => item.id.length > 0);
  } catch {
    // 期限条目是可选输入：不可解析时按未求值处理，不编日期。
    return undefined;
  }
}

export class ProcedureChecklistHandler implements StageHandler {
  readonly name = "procedure-checklist";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const kind: ProcedureKind =
      getStateString(state, "procedure_kind") === "reexamination" ? "reexamination" : "invalidation";
    const checklist = buildProcedureChecklist({
      kind,
      text: getStateString(state, "text"),
      chart: getStateString(state, "claim_chart_doc"),
      deadlines: readDeadlines(getStateString(state, "deadline_entries")),
    });
    return { procedure_checklist: checklist.markdown };
  }
}
