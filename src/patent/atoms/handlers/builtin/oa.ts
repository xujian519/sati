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
import { asRecord, parseJsonValue } from "../../../json.js";
import { tryParseJson } from "../../../llm-json.js";
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
  inputSchema: ["claim", "claim_chart_doc", "gap_list", "amendment_diff", "oa_grounds"],
  outputSchema: ["oa_statement"],
};

export type ChartRowRef = {
  elementId: string;
  targetId: string;
  mapping: string;
  quote: string;
  pinCite: string;
};

/** 从对照表取可用于引用的要素编号与证据行（证据行进入起草提示词）。 */
function readChartRefs(chartRaw: string): { elementIds: Set<string>; rows: ChartRowRef[] } {
  const chart = asRecord(parseJsonValue(chartRaw));
  const elements = Array.isArray(chart?.elements) ? chart.elements : [];
  const rawRows = Array.isArray(chart?.rows) ? chart.rows : [];
  const elementIds = new Set<string>();
  for (const element of elements) {
    const record = asRecord(element);
    const id = record?.id;
    if (typeof id === "string" && id.length > 0) elementIds.add(id);
  }
  const rows = rawRows
    .map(row => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .map(row => ({
      elementId: typeof row.elementId === "string" ? row.elementId : "",
      targetId: typeof row.targetId === "string" ? row.targetId : "",
      mapping: typeof row.mapping === "string" ? row.mapping : "",
      quote: typeof row.quote === "string" ? row.quote : "",
      pinCite: typeof row.pinCite === "string" ? row.pinCite : "",
    }))
    .filter(row => row.elementId.length > 0 && row.targetId.length > 0);
  return { elementIds, rows };
}

/** 只有已锚定（原申请文本可定位）的限定额允许被争辩段落引用。 */
function readLimitations(amendmentRaw: string): string[] {
  const parsed = asRecord(parseJsonValue(amendmentRaw));
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined && item.status === "anchored")
    .map(item => (typeof item.limitation === "string" ? item.limitation.trim() : ""))
    .filter(text => text.length > 0);
}

function formatChartRows(rows: readonly ChartRowRef[]): string {
  if (rows.length === 0) return "（对照表没有证据行）";
  return rows
    .map(
      (row, index) =>
        `${index + 1}. ${row.elementId} → ${row.targetId}（${row.mapping || "未标注"}）：${row.quote || "（无引文）"}${
          row.pinCite.length > 0 ? `（${row.pinCite}）` : ""
        }`,
    )
    .join("\n")
    .slice(0, 4000);
}

/** 引用过滤：每个 ref 都必须命中已存在的要素编号或已锚定限定原文，否则整段丢弃。 */
function filterNotes(
  parsed: Record<string, unknown> | undefined,
  elementIds: ReadonlySet<string>,
  limitations: readonly string[],
): { notes: Array<{ text: string; refs: string[] }>; dropped: number; total: number } {
  const rawNotes = Array.isArray(parsed?.notes) ? parsed.notes : [];
  const notes: Array<{ text: string; refs: string[] }> = [];
  let dropped = 0;
  for (const entry of rawNotes) {
    const record = asRecord(entry);
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    const refs = Array.isArray(record?.refs)
      ? record.refs.map(ref => (typeof ref === "string" ? ref.trim() : "")).filter(Boolean)
      : [];
    const valid =
      text.length > 0 && refs.length > 0 && refs.every(ref => elementIds.has(ref) || limitations.includes(ref));
    if (!valid) {
      dropped += 1;
      continue;
    }
    notes.push({ text, refs });
  }
  return { notes, dropped, total: rawNotes.length };
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

  // 权利要求原文在 state.claim（工具输入 claimText 或 input 回退）；
  // claim_chart_doc 是 ClaimChart，契约里没有 claim 字段。
  const claim = getStateString(state, "claim");
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

/** 意见陈述的产出状态：成功与三类降级可区分，审批面不会把空稿当草稿。 */
export type OaDraftStatus =
  | "draft"
  | "degraded_no_chart"
  | "degraded_no_llm"
  | "degraded_unparsable"
  | "degraded_empty_notes"
  | "degraded_all_dropped";

type OaStatementParts = {
  status: OaDraftStatus;
  reason?: string;
  grounds: unknown;
  chartGaps: unknown;
  amendments: unknown;
  notes: Array<{ text: string; refs: string[] }>;
  dropped: number;
};

function buildOaStatement(parts: OaStatementParts): Record<string, unknown> {
  return {
    status: parts.status,
    ...(parts.reason !== undefined ? { reason: parts.reason } : {}),
    grounds: parts.grounds,
    chartGaps: parts.chartGaps,
    amendments: parts.amendments,
    argumentNotes: parts.notes,
    droppedNotes: parts.dropped,
    draftNotice: OA_DRAFT_NOTICE,
  };
}

async function withSnapshot(
  state: PipelineState,
  provider: StageExecuteInput["provider"],
  statement: Record<string, unknown>,
): Promise<PipelineState> {
  return { oa_statement: JSON.stringify({ ...statement, snapshot: await maybeSnapshot(state, provider, statement) }) };
}

export class DraftOaHandler implements StageHandler {
  readonly name = "draft-oa";
  readonly category = "reason" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const chartRaw = getStateString(state, "claim_chart_doc");
    const grounds = parseJsonValue(getStateString(state, "oa_grounds"));
    const chartGaps = parseJsonValue(getStateString(state, "gap_list"));
    const amendments = parseJsonValue(getStateString(state, "amendment_diff"));

    if (chartRaw.trim().length === 0) {
      return {
        oa_statement: JSON.stringify({
          ...buildOaStatement({
            status: "degraded_no_chart",
            reason: OA_NO_CHART_REASON,
            grounds,
            chartGaps,
            amendments,
            notes: [],
            dropped: 0,
          }),
          snapshot: "skipped-no-chart",
        }),
      };
    }

    const chart = readChartRefs(chartRaw);
    const limitations = readLimitations(getStateString(state, "amendment_diff"));
    const claim = getStateString(state, "claim");

    const prompt = [
      "你是专利代理师，正在起草审查意见答复的争辩意见部分。",
      "只写争辩段落；不要编造对比文件内容，不要引用未在下面列出的要素编号或限定。",
      "",
      "【权利要求原文】",
      claim.trim().length > 0 ? dataBlock(claim.slice(0, 3000)) : "（未提供权利要求原文）",
      "【理由分型】",
      dataBlock(JSON.stringify(grounds, null, 2).slice(0, 3000)),
      "【权利要求要素编号】",
      dataBlock([...chart.elementIds].join(", ").slice(0, 1500)),
      "【对照表证据行】",
      dataBlock(formatChartRows(chart.rows)),
      "【对照表缺口】",
      dataBlock(JSON.stringify(chartGaps, null, 2).slice(0, 3000)),
      "【修改差分】",
      dataBlock(JSON.stringify(amendments, null, 2).slice(0, 3000)),
      "",
      "每段 refs 只能使用上面出现过的要素编号，或修改差分里 status=anchored 的限定原文。",
      "严格输出 JSON：{ notes: [{ text, refs }] }。",
    ].join("\n");

    const result = await callLlm(provider, "draft-oa", prompt, { schema: DRAFT_NOTES_SCHEMA, temperature: 0.2 });
    if (!result.ok) {
      const statement = buildOaStatement({
        status: "degraded_no_llm",
        reason: result.message,
        grounds,
        chartGaps,
        amendments,
        notes: [],
        dropped: 0,
      });
      return withSnapshot(state, provider, statement);
    }

    const parsed = tryParseJson(result.raw);
    if (parsed === undefined) {
      const statement = buildOaStatement({
        status: "degraded_unparsable",
        reason: "模型输出不是 JSON，未生成争辩段落",
        grounds,
        chartGaps,
        amendments,
        notes: [],
        dropped: 0,
      });
      return withSnapshot(state, provider, statement);
    }

    const { notes, dropped, total } = filterNotes(parsed, chart.elementIds, limitations);
    const reason =
      total === 0
        ? "模型未产出争辩段落"
        : notes.length === 0
          ? `全部争辩段落引用不存在的要素或限定（丢弃 ${dropped} 段）`
          : undefined;
    const status: OaDraftStatus =
      total === 0 ? "degraded_empty_notes" : notes.length === 0 ? "degraded_all_dropped" : "draft";
    const statement = buildOaStatement({
      status,
      ...(reason !== undefined ? { reason } : {}),
      grounds,
      chartGaps,
      amendments,
      notes,
      dropped,
    });
    return withSnapshot(state, provider, statement);
  }
}
