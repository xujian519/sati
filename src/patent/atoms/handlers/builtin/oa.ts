/**
 * 审查意见答复域原子：oa-grounds（理由分型）/ amendment-diff（修改差分）/
 * draft-oa（意见陈述汇编）。
 *
 * 三者都只消费上游已经产出的结构：不重新检索、不重新拆权利要求。
 * 降级与「未核对」状态写进主输出键（outputSchema[0]），而不是只返回 `_error`
 * ——自动执行路径在 `{ _error }` 时阶段输出为空，原因会被丢掉。
 */

import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import { classifyGrounds } from "../../../oa/grounds.js";
import { diffAmendments, NOT_CHECKED_REASON } from "../../../oa/amendment-diff.js";
import { writeOaRoundSnapshot } from "../../../oa/round-snapshot.js";
import { dataBlock } from "../../../prompt-hygiene.js";
import { callLlm } from "./llm.js";

/** 意见陈述的固定草稿声明（与 claim-chart 的 DRAFT_NOTICE 同级）。 */
export const OA_DRAFT_NOTICE = "本意见陈述为草稿，须由署名代理人复核后才能形成呈递文本。";

/** 缺对照表时的固定说明。 */
export const OA_NO_CHART_REASON = "意见陈述缺少要素对照：未找到 claim_chart_doc";

function readMaterial(state: PipelineState): string {
  for (const key of ["text", "input", "source_text"]) {
    const value = getStateString(state, key);
    if (value.trim().length > 0) return value;
  }
  return "";
}

/** 容错解析上游 JSON：失败时原样保留字符串，避免静默丢数据。 */
function parseJsonOrRaw(value: string): unknown {
  if (value.trim().length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // 上游可能传纯文本：原样保留，不用异常打断答复阶段。
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// oa-grounds
// ---------------------------------------------------------------------------

export const oaGroundsAtom: Atom = {
  name: "oa-grounds",
  description: "从材料原文识别审查意见/无效理由的法条代码（新颖性/创造性/清楚/公开/超范围/单一性）",
  category: "extract",
  inputSchema: ["text"],
  outputSchema: ["oa_grounds"],
};

export class OaGroundsHandler implements StageHandler {
  readonly name = "oa-grounds";
  readonly category = "extract" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const material = readMaterial(state);
    if (material.trim().length === 0) {
      return {
        oa_grounds: JSON.stringify({
          codes: ["unidentified"],
          unidentified: true,
          evidence: [],
          reason: "未提供材料原文，理由分型未执行",
        }),
      };
    }
    return { oa_grounds: JSON.stringify(classifyGrounds(material)) };
  }
}

// ---------------------------------------------------------------------------
// amendment-diff
// ---------------------------------------------------------------------------

export const amendmentDiffAtom: Atom = {
  name: "amendment-diff",
  description: "逐条核对拟修改限定能否在原申请文本中连续命中（缺段即未核对，不产出已核对结论）",
  category: "gate",
  inputSchema: ["text"],
  outputSchema: ["amendment_diff"],
};

export class AmendmentDiffHandler implements StageHandler {
  readonly name = "amendment-diff";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const material = readMaterial(state);
    if (material.trim().length === 0) {
      return {
        amendment_diff: JSON.stringify({
          status: "not_checked",
          reason: NOT_CHECKED_REASON,
          items: [{ limitation: "", status: "not_checked", hits: [], reason: NOT_CHECKED_REASON }],
        }),
      };
    }
    return { amendment_diff: JSON.stringify(diffAmendments(material)) };
  }
}

// ---------------------------------------------------------------------------
// draft-oa
// ---------------------------------------------------------------------------

const DRAFT_NOTES_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "一段争辩意见" },
          refs: {
            type: "array",
            items: { type: "string" },
            description: "该段引用的权利要求要素编号（如 1a）或拟修改限定原文",
          },
        },
        required: ["text", "refs"],
      },
    },
  },
  required: ["notes"],
} as const;

export const draftOaAtom: Atom = {
  name: "draft-oa",
  description: "汇编意见陈述草稿：消费对照表、缺口、理由分型与修改差分，不重新检索",
  category: "reason",
  inputSchema: ["claim_chart_doc", "gap_list", "amendment_diff", "oa_grounds"],
  outputSchema: ["oa_statement"],
};

/** 从对照表取可用于引用的要素编号与文献行摘要。 */
function readChartRefs(chartRaw: string): {
  elementIds: Set<string>;
  targets: unknown;
  rows: Array<{ elementId?: string; targetId?: string; mapping?: string }>;
} {
  const chart = asRecord(parseJsonOrRaw(chartRaw));
  const elements = Array.isArray(chart?.elements) ? chart.elements : [];
  const rows = Array.isArray(chart?.rows) ? (chart.rows as Array<Record<string, unknown>>) : [];
  const elementIds = new Set<string>();
  for (const element of elements) {
    const record = asRecord(element);
    const id = record?.id;
    if (typeof id === "string" && id.length > 0) elementIds.add(id);
  }
  return {
    elementIds,
    targets: chart?.targets ?? [],
    rows: rows.map(row => ({
      ...(typeof row.elementId === "string" ? { elementId: row.elementId } : {}),
      ...(typeof row.targetId === "string" ? { targetId: row.targetId } : {}),
      ...(typeof row.mapping === "string" ? { mapping: row.mapping } : {}),
    })),
  };
}

function readLimitations(amendmentRaw: string): string[] {
  const parsed = asRecord(parseJsonOrRaw(amendmentRaw));
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items
    .map(item => asRecord(item))
    .map(item => (typeof item?.limitation === "string" ? item.limitation.trim() : ""))
    .filter(text => text.length > 0);
}

/** 引用过滤：每个 ref 都必须命中已存在的要素编号或限定原文，否则整段丢弃。 */
function filterNotes(
  raw: string,
  elementIds: ReadonlySet<string>,
  limitations: readonly string[],
): { notes: Array<{ text: string; refs: string[] }>; dropped: number } {
  const parsed = asRecord(parseJsonOrRaw(raw));
  const rawNotes = Array.isArray(parsed?.notes) ? parsed.notes : [];
  const notes: Array<{ text: string; refs: string[] }> = [];
  let dropped = 0;
  for (const entry of rawNotes) {
    const record = asRecord(entry);
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    const refs = Array.isArray(record?.refs) ? record.refs.filter((ref): ref is string => typeof ref === "string") : [];
    const valid =
      text.length > 0 && refs.length > 0 && refs.every(ref => elementIds.has(ref) || limitations.includes(ref));
    if (!valid) {
      dropped += 1;
      continue;
    }
    notes.push({ text, refs });
  }
  return { notes, dropped };
}

/**
 * 写轮次快照（仅在有合法 caseId 时）。
 *
 * 失败不回滚阶段产出：把 `failed: ...` 写进 `snapshot` 字段，让「没落盘」
 * 可观测，而不是让整个答复阶段失败。
 */
async function maybeSnapshot(
  state: PipelineState,
  provider: StageExecuteInput["provider"],
  statement: Record<string, unknown>,
): Promise<string | undefined> {
  const caseId = provider?.caseId;
  if (caseId === undefined || caseId.trim().length === 0) return "skipped-no-case";

  const chart = asRecord(parseJsonOrRaw(getStateString(state, "claim_chart_doc")));
  const claim = typeof chart?.claim === "string" ? chart.claim : "";
  try {
    const snapshot = await writeOaRoundSnapshot({
      caseId,
      artifacts: [
        { name: "oa_statement.json", content: JSON.stringify(statement, null, 2) },
        { name: "amendment_diff.json", content: getStateString(state, "amendment_diff") || "{}" },
        { name: "claims_before.md", content: claim.trim().length > 0 ? claim : "（未提供原权利要求文本）" },
      ],
    });
    return `round-${snapshot.round}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export class DraftOaHandler implements StageHandler {
  readonly name = "draft-oa";
  readonly category = "reason" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const chartRaw = getStateString(state, "claim_chart_doc");
    if (chartRaw.trim().length === 0) {
      return {
        oa_statement: JSON.stringify({
          status: "degraded_no_chart",
          reason: OA_NO_CHART_REASON,
          grounds: parseJsonOrRaw(getStateString(state, "oa_grounds")),
          chartGaps: parseJsonOrRaw(getStateString(state, "gap_list")),
          amendments: parseJsonOrRaw(getStateString(state, "amendment_diff")),
          argumentNotes: [],
          droppedNotes: 0,
          draftNotice: OA_DRAFT_NOTICE,
          snapshot: "skipped-no-chart",
        }),
      };
    }

    const chart = readChartRefs(chartRaw);
    const limitations = readLimitations(getStateString(state, "amendment_diff"));
    const grounds = parseJsonOrRaw(getStateString(state, "oa_grounds"));
    const amendments = parseJsonOrRaw(getStateString(state, "amendment_diff"));
    const chartGaps = parseJsonOrRaw(getStateString(state, "gap_list"));

    const prompt = [
      "你是专利代理师，正在起草审查意见答复的争辩意见部分。",
      "只写争辩段落；不要编造对比文件内容，不要引用未在下面列出的要素编号或限定。",
      "",
      "【理由分型】",
      dataBlock(JSON.stringify(grounds, null, 2).slice(0, 3000)),
      "【权利要求要素编号】",
      dataBlock([...chart.elementIds].join(", ").slice(0, 1500)),
      "【对照表缺口】",
      dataBlock(JSON.stringify(chartGaps, null, 2).slice(0, 3000)),
      "【修改差分】",
      dataBlock(JSON.stringify(amendments, null, 2).slice(0, 3000)),
      "",
      "每段 refs 只能使用上面出现过的要素编号，或修改差分里的限定原文。",
      "严格输出 JSON：{ notes: [{ text, refs }] }。",
    ].join("\n");

    const result = await callLlm(provider, "draft-oa", prompt, { schema: DRAFT_NOTES_SCHEMA, temperature: 0.2 });
    if (!result.ok) {
      const statement: Record<string, unknown> = {
        status: "degraded_no_llm",
        reason: result.message,
        grounds,
        chartGaps,
        amendments,
        argumentNotes: [],
        droppedNotes: 0,
        draftNotice: OA_DRAFT_NOTICE,
      };
      return {
        oa_statement: JSON.stringify({ ...statement, snapshot: await maybeSnapshot(state, provider, statement) }),
      };
    }

    const { notes, dropped } = filterNotes(result.raw, chart.elementIds, limitations);
    const statement: Record<string, unknown> = {
      status: "draft",
      grounds,
      chartGaps,
      amendments,
      argumentNotes: notes,
      droppedNotes: dropped,
      draftNotice: OA_DRAFT_NOTICE,
    };
    return {
      oa_statement: JSON.stringify({ ...statement, snapshot: await maybeSnapshot(state, provider, statement) }),
    };
  }
}
