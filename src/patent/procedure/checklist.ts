/**
 * 复审/无效程序核验清单（纯函数）。
 *
 * 输出是**核验表**，不是请求书：文首固定声明，期限只引用调用方已求值的那一条，
 * 缺记录就保持待定，不推算日期。
 *
 * 期限条目不在这里求值：`evaluateDeadlines` 需要申请日、今天、专利类型与工作日历，
 * 缺任一项会抛错。调用方把已求值的条目传进来，本模块只做筛选与措辞。
 */

import { classifyGrounds } from "../oa/grounds.js";

export type ProcedureKind = "reexamination" | "invalidation";

/** 期限求值条目（与 `evaluateDeadlines` 返回项的形状对齐，字段按需读取）。 */
export type ProcedureDeadlineEntry = {
  id: string;
  status?: string;
  /** 待定原因（`PendingDeadline.reason`）。 */
  reason?: string;
  /** 已计算出的截止日期（仅复审请求条目会渲染）。 */
  date?: string;
};

export type ProcedureChecklistItem = {
  id: string;
  label: string;
  status: "met" | "pending" | "blocked" | "not_evaluated";
  detail: string;
};

export type ProcedureChecklist = {
  kind: ProcedureKind;
  notice: string;
  items: ProcedureChecklistItem[];
  markdown: string;
};

/** 文首固定声明（第一行）。 */
export const PROCEDURE_DRAFT_NOTICE = "本清单用于核对程序事项与证据对应关系，不是复审请求书，也不是无效宣告请求书。";

/** 复审请求期限的固定条目 id（`deadline-rules.ts`）。 */
export const REEXAMINATION_REQUEST_DEADLINE_ID = "reexamination-request";

type ChartShape = {
  targets?: unknown;
  elements?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countTargets(chart: ChartShape | undefined): number {
  return Array.isArray(chart?.targets) ? chart.targets.length : 0;
}

function deadlineItem(
  kind: ProcedureKind,
  deadlines: readonly ProcedureDeadlineEntry[] | undefined,
): ProcedureChecklistItem {
  if (kind === "invalidation") {
    return {
      id: "deadline",
      label: "期限",
      status: "not_evaluated",
      detail: "无对应期限条目",
    };
  }
  if (deadlines === undefined) {
    return {
      id: "deadline",
      label: "期限",
      status: "not_evaluated",
      detail: "期限未求值（缺少申请日、送达记录或工作日历）",
    };
  }
  const entry = deadlines.find(item => item.id === REEXAMINATION_REQUEST_DEADLINE_ID);
  if (entry === undefined) {
    return {
      id: "deadline",
      label: "期限",
      status: "not_evaluated",
      detail: "期限结果中没有复审请求条目",
    };
  }
  if (entry.status === "pending") {
    return {
      id: "deadline",
      label: "期限",
      status: "pending",
      detail: entry.reason ?? "期限待定（缺少起算所需的送达记录）",
    };
  }
  if (entry.date !== undefined && entry.date.trim().length > 0) {
    return {
      id: "deadline",
      label: "期限",
      status: "met",
      detail: entry.date,
    };
  }
  return {
    id: "deadline",
    label: "期限",
    status: "pending",
    detail: entry.reason ?? "期限待定",
  };
}

function renderMarkdown(checklist: Omit<ProcedureChecklist, "markdown">): string {
  const lines = [checklist.notice, "", `## 程序核验（${checklist.kind === "reexamination" ? "复审" : "无效"}）`, ""];
  for (const item of checklist.items) {
    const mark =
      item.status === "met" ? "✅" : item.status === "pending" ? "⏳" : item.status === "blocked" ? "❌" : "⚠️";
    lines.push(`- ${mark} ${item.label}：${item.detail}`);
  }
  return lines.join("\n");
}

export type BuildProcedureChecklistInput = {
  kind: ProcedureKind;
  /** 材料原文（用于理由分型）。 */
  text: string;
  /** claim-chart 的 JSON（字符串或已解析对象）。 */
  chart?: unknown;
  /** 已求值的期限条目；缺省表示未求值。 */
  deadlines?: readonly ProcedureDeadlineEntry[];
};

/** 构建程序核验清单。 */
export function buildProcedureChecklist(input: BuildProcedureChecklistInput): ProcedureChecklist {
  const chart = typeof input.chart === "string" ? asRecord(safeParse(input.chart)) : asRecord(input.chart);
  const targetCount = countTargets(chart as ChartShape | undefined);
  const grounds = classifyGrounds(input.text);

  const items: ProcedureChecklistItem[] = [deadlineItem(input.kind, input.deadlines)];

  items.push({
    id: "grounds",
    label: "理由",
    status: grounds.unidentified ? "blocked" : "met",
    detail: grounds.unidentified
      ? "未从输入识别审查或无效理由"
      : grounds.codes.filter(code => code !== "other").join("、") || "仅识别到未归类表述",
  });

  items.push({
    id: "evidence",
    label: "证据目标",
    status: targetCount > 0 ? "met" : "blocked",
    detail: targetCount > 0 ? `对照表含 ${targetCount} 个目标` : "对照表没有证据目标",
  });

  if (grounds.unidentified && targetCount === 0) {
    items.push({
      id: "pairing",
      label: "理由与证据对应",
      status: "blocked",
      detail: "既没有可识别理由，也没有证据目标",
    });
  }

  const withoutMarkdown = { kind: input.kind, notice: PROCEDURE_DRAFT_NOTICE, items };
  return { ...withoutMarkdown, markdown: renderMarkdown(withoutMarkdown) };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // chart 可能是纯文本：缺结构时按「没有目标」处理，由调用方标 blocked。
    return undefined;
  }
}
