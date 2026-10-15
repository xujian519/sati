/**
 * src/patent/fees/report — 把计价结果渲染成一份可读的缴费清单。
 *
 * 渲染纪律（与 A3 的期限报告同一条）：**降级必须看得见**。
 *
 * - 未给合计时，先写「未给合计」并**指名**是哪些行挡住了它，再谈别的——不要把一份局部和
 *   排版成像结论的价格。
 * - 未核验的行在表里带状态列，且金额列显示为 `—`（而不是 0）。
 * - 「本次没有可计价条目」必须补一句「这不等于本案没有费用」，因为 `triggers` 是覆盖面。
 */

import { PATENT_TYPE_LABELS } from "./fees.js";
import type { AmountStatus, FeeLine, FeeReport, PatentType } from "./types.js";

/** 报告头部需要的、来自查询与索引的事实。 */
export type FeeReportMeta = {
  patentType: PatentType;
  /** 本案点到的环节，逗号分隔后写进表头（它就是报告的覆盖面）。 */
  triggers: readonly string[];
  /** 索引所据的文书。 */
  sourceDoc: string | null;
  /** 索引对准的版本。 */
  revision: string | null;
  /** 索引的核验日期。 */
  verifiedOn: string | null;
};

const STATUS_LABELS: Record<AmountStatus, string> = {
  verified: "已核验",
  unverified: "未核验",
  unrecorded: "金额未转录",
};

/**
 * 渲染缴费清单。
 * @param report - 计价结果。
 * @param meta - 查询与索引的事实。
 * @returns Markdown 报告。
 */
export function renderFeeReport(report: FeeReport, meta: FeeReportMeta): string {
  const blocks: string[] = [renderHeader(report, meta), renderLines(report), renderTotal(report)];
  if (report.reduction !== null) blocks.push(renderReduction(report));
  const pending = renderPending(report);
  if (pending !== "") blocks.push(pending);
  const notes = renderNotes(report);
  if (notes !== "") blocks.push(notes);
  const sources = renderSources(report);
  if (sources !== "") blocks.push(sources);
  return blocks.filter(block => block !== "").join("\n\n");
}

/** 头部：这次算的是哪个案子、依据哪份文书。 */
function renderHeader(report: FeeReport, meta: FeeReportMeta): string {
  const lines = [
    `# 官费计价（${PATENT_TYPE_LABELS[meta.patentType]}，${report.currency}）`,
    "",
    `**计价环节**：${meta.triggers.length === 0 ? "（未指定）" : meta.triggers.join("、")}——未点到的环节**一律不计价**，漏一个环节在下面读起来就是「该环节不收费」。`,
  ];
  const standard = [meta.sourceDoc ?? "（索引未登记出处）", meta.revision === null ? null : `版本 ${meta.revision}`]
    .filter((part): part is string => part !== null)
    .join("；");
  lines.push(
    `**费率依据**：${standard}${meta.verifiedOn === null ? "（**未登记核验日期**，下列金额按未核验处理）" : `（逐条核对于 ${meta.verifiedOn}）`}`,
  );
  return lines.join("\n");
}

/** 计价表。 */
function renderLines(report: FeeReport): string {
  if (report.lines.length === 0) {
    return (
      "本次没有可计价的费用条目。**这不等于本案没有费用**——`triggers` 是报告的覆盖面，" +
      "请核对是否漏了环节（见下面的说明）。"
    );
  }
  const rows = report.lines.map(line => {
    const unit = line.unitAmount ?? "—";
    const subtotal = line.subtotal ?? "—";
    const payable = line.payable ?? "—";
    return `| ${line.name} | ${line.quantityBasis} | ${String(line.quantity)} | ${unit} | ${subtotal} | ${payable} | ${STATUS_LABELS[line.status]} | ${line.reduction ?? "—"} | ${line.legalBasis ?? "—"} |`;
  });
  return [
    `| 费用项 | 计数依据 | 份数 | 单价(${report.currency}) | 小计 | 应付 | 金额状态 | 减缴 | 依据 |`,
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** 合计（或对合计的明确拒绝）。 */
function renderTotal(report: FeeReport): string {
  if (report.lines.length === 0) {
    return (
      "**本次未给出合计**：所给计价环节与专利类型在索引里没有匹配到任何可计价条目。" +
      "**0 元不是答案**——请核对计价环节是否漏了（见下面的说明）。"
    );
  }
  if (report.total.complete && report.total.amount !== null) {
    return `**合计（全部已核验）**：${report.total.amount} ${report.currency}`;
  }
  const names = report.total.unverifiedIds.join("、");
  if (report.total.amount === null) {
    return (
      `**本次未给出合计**：${String(report.total.unverifiedIds.length)} 项适用费用没有已核验的应缴金额（${names}）。` +
      `索引未转录的金额是**未知**，不是零；请按官方收费标准公告补录，或按上表逐项人工核价——` +
      `不要把上面任何一行的数字相加当成案子的价格。`
    );
  }
  return (
    `**部分合计**：${report.total.amount} ${report.currency}（仅含已核验项；${names} 未计入）。` + `这不是案子的价格。`
  );
}

/** 减缴段。 */
function renderReduction(report: FeeReport): string {
  const reduction = report.reduction;
  if (reduction === null) return "";
  return [
    `**费用减缴**：${reduction.reason}`,
    "",
    `- 资格：${reduction.kind}｜申请人/专利权人 ${String(reduction.applicants)} 名｜已备案：${reduction.filed ? "是" : "否"}`,
    `- 比例的由来：${reduction.reductionBasis}`,
    `- 是否作用到费用项：${reduction.applied ? "是" : "否"}`,
  ].join("\n");
}

/** 待补输入。 */
function renderPending(report: FeeReport): string {
  if (report.pending.length === 0) return "";
  return [
    "**待补输入**（本工具不自行推算，且这些条目已挡住合计）：",
    ...report.pending.map(item => `- ${item.name}（${item.id}）：需要 \`${item.requiredInput}\`——${item.reason}`),
  ].join("\n");
}

/** 说明：报告级 + 行级。 */
function renderNotes(report: FeeReport): string {
  const notes = [
    ...report.notes,
    ...report.lines.flatMap(line => line.notes.map(note => `${line.name}（${line.id}）：${note}`)),
  ];
  if (notes.length === 0) return "";
  return ["**说明**：", ...notes.map(note => `- ${note}`)].join("\n");
}

/** 金额出处：只列真正出现了数字的行，便于逐条回原文核对。 */
function renderSources(report: FeeReport): string {
  const withAmount = report.lines.filter((line: FeeLine) => line.unitAmount !== null);
  if (withAmount.length === 0) return "";
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const line of withAmount) {
    const source = line.valueSource;
    const key = `${source.sourceDoc ?? ""}|${source.sourceUrl ?? ""}|${source.publishedOn ?? ""}|${source.verifiedOn ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(
      `- ${source.sourceDoc ?? "（未登记出处）"}` +
        `${source.sourceUrl === null ? "" : `｜${source.sourceUrl}`}` +
        `｜发布 ${source.publishedOn ?? "未登记"}｜核对 ${source.verifiedOn ?? "**未核验**"}`,
    );
  }
  return ["**金额出处**（逐条可回原文核对）：", ...rows].join("\n");
}
