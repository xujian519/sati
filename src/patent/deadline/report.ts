/**
 * src/patent/deadline/report — 期限报告的模型可读渲染。
 *
 * 报告要把三件事说清楚，否则机械判据会被读成结论：
 *
 * 1. **顺延口径**（细则第 5 条是否应用、日历覆盖到哪一年）；
 * 2. **判决值 vs 下界**——日历未覆盖年份时参考性期限只有一个「仅按周末顺延」的下界，
 *    报告必须显式标出，不得让它看起来像判决值；
 * 3. **可否请求恢复**——细则第 6 条第 5 款把专利法第 24、29、42、74 条的期限排除在恢复之外，
 *    故不能对逾期项一律给出「可以恢复」的通用建议（dsh 的写法会这样暗示）。
 */

import { UNCOVERED_YEAR_CAVEAT_PREFIX, describePatentKind, type DeadlineReport, type PatentKind } from "./statutes.js";

/** 报告抬头需要的案件上下文。 */
export type DeadlineReportMeta = {
  kind: PatentKind;
  filingDate: string;
  today: string;
  /** 案件是否主张优先权（调用方给出的事实）。 */
  claimsPriority: boolean;
  /** 优先权日（适用时）。 */
  priorityDate?: string;
};

const STATUS_LABEL = {
  overdue: "⛔ 已逾期",
  urgent: "🔴 紧急",
  normal: "🟢 正常",
} as const;

/**
 * 渲染期限报告为 Markdown。
 * @param report - 求值结果。
 * @param meta - 抬头用的案件上下文。
 * @returns Markdown 报告。
 */
export function renderDeadlineReport(report: DeadlineReport, meta: DeadlineReportMeta): string {
  const priority = meta.claimsPriority
    ? ` · 主张优先权${meta.priorityDate !== undefined ? `（优先权日 ${meta.priorityDate}）` : ""}`
    : " · 未主张优先权";
  const lines: string[] = [
    `patent_deadlines: ${describePatentKind(meta.kind)} · 申请日 ${meta.filingDate} · 基准日 ${meta.today}${priority}`,
    "",
  ];

  lines.push(
    report.restDayRule === "apply"
      ? "期限口径：已应用专利法实施细则第5条的届满日顺延（届满日为法定休假日或移用周休息日的，顺延至其后第一个工作日）；「期限本体」列为不顺延的原始届满日。"
      : "期限口径：**不顺延**——每个期限只报其自身届满日，未应用专利法实施细则第5条的顺延规则。此口径适用于记录期限本身（如专利权期限届满日）；答复、缴费类期限请改用顺延口径。",
    "",
  );
  lines.push(
    `工作日历已覆盖：${report.calendarCoveredYears.length > 0 ? report.calendarCoveredYears.join("、") : "（无）"}。`,
    "",
  );

  if (report.computed.length === 0) {
    lines.push("本次查询未产出可计算的期限。", "");
  } else {
    const overdue = report.computed.filter(entry => entry.status === "overdue").length;
    const urgent = report.computed.filter(entry => entry.status === "urgent").length;
    lines.push(
      `可计算期限 ${String(report.computed.length)} 项（已逾期 ${String(overdue)} 项，${String(urgent)} 项临近）。`,
      "",
      "| 期限事项 | 届满日 | 期限本体 | 剩余 | 状态 | 法律依据 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of report.computed) {
      const remaining =
        entry.daysRemaining < 0 ? `已逾期 ${String(-entry.daysRemaining)} 天` : `${String(entry.daysRemaining)} 天`;
      const shown =
        entry.dueDate !== undefined
          ? `${entry.dueDate}${entry.calendarCaveat !== undefined ? " ⚠️" : ""}`
          : `${entry.dueDateLowerBound ?? "—"}（**下界**，非判决值）`;
      const raw = entry.rolledForward ? entry.rawDueDate : "—";
      lines.push(
        `| ${entry.label} | ${shown} | ${raw} | ${remaining} | ${STATUS_LABEL[entry.status]} | ${entry.legalBasis} |`,
      );
    }
    lines.push("");
  }

  if (report.pending.length > 0) {
    lines.push(
      `无法计算的期限 ${String(report.pending.length)} 项——需补充下列记录后重算，本工具**不以固定年数代替通知书送达日**：`,
      "",
    );
    for (const entry of report.pending) {
      lines.push(`- ${entry.label}（${entry.legalBasis}）｜缺少：${entry.requiredInput}｜${entry.reason}`);
    }
    lines.push("");
  }

  // 送达口径需复核的提示（如电子送达的进入日与发文日不一致）。
  const triggers = report.computed.filter(entry => entry.triggerCaveat !== undefined);
  if (triggers.length > 0) {
    lines.push("⚠️ 起算点需复核：", "");
    for (const entry of triggers) {
      lines.push(`- ${entry.label}：${entry.triggerCaveat}`);
    }
    lines.push("");
  }

  const caveats = report.computed.filter(entry => entry.calendarCaveat !== undefined);
  if (caveats.length > 0) {
    const years = [
      ...new Set(caveats.map(entry => (entry.calendarCaveat ?? "").slice(UNCOVERED_YEAR_CAVEAT_PREFIX.length))),
    ].sort();
    const actionable = caveats.filter(entry => entry.requiresFullCalendar);
    const reference = caveats.filter(entry => !entry.requiresFullCalendar);
    lines.push(
      `⚠️ 本地节假日安排未覆盖 ${years.join("、")} 年，下列届满日**未能判定顺延**，只给出「仅按周末顺延」的下界` +
        "（真实届满日不早于此，按下界办事一定不晚）：",
      "",
    );
    for (const entry of caveats) {
      lines.push(
        `- ${entry.label}（${entry.requiresFullCalendar ? "**最后一天要办事**" : "参考性日期"}）：` +
          `期限本体 ${entry.rawDueDate}，下界 ${entry.dueDateLowerBound ?? "—"}`,
      );
    }
    lines.push("");
    if (actionable.length > 0) {
      lines.push(
        `其中 ${String(actionable.length)} 项是「最后一天要办事」的期限，下界与真实届满日可能相差数日，` +
          `**务必补齐 ${years.join("、")} 年节假日安排后重算**再据以办理。`,
        "",
      );
    }
    if (reference.length > 0) {
      lines.push(`另有 ${String(reference.length)} 项为参考性日期（不因该日未办而丧失权利），下界仅供参考。`, "");
    }
  }

  const lateWindows = report.computed.filter(entry => entry.latePaymentWindow !== undefined);
  if (lateWindows.length > 0) {
    lines.push("年费补缴窗口（逾期后 6 个月内仍可补缴并缴滞纳金，期满未缴专利权自应缴年费期满之日起终止）：", "");
    for (const entry of lateWindows) {
      const window = entry.latePaymentWindow;
      if (window === undefined) continue;
      lines.push(`- ${entry.label}：${window.from} 起算，最迟 ${window.to}。`);
    }
    lines.push("");
  }

  // 恢复与延长——按条目区分，而不是给一句通用建议。
  const overdueEntries = report.computed.filter(entry => entry.status === "overdue");
  const restorable = overdueEntries.filter(entry => entry.restorationExcluded === undefined);
  const notRestorable = overdueEntries.filter(entry => entry.restorationExcluded !== undefined);
  if (restorable.length > 0) {
    lines.push(
      "已逾期项请先判断是否仍在救济期内：因不可抗拒的事由延误的，可自障碍消除之日起2个月内" +
        "且自期限届满之日起2年内请求恢复权利；因其他正当理由延误的，可自收到通知之日起2个月内" +
        "请求恢复（延误复审请求期限的，自该期限届满之日起2个月内），并缴纳恢复权利请求费" +
        "（专利法实施细则第6条）。指定期限在届满前还可请求延长，延长不超过两个月" +
        "（专利审查指南第五部分第七章）。",
      "",
    );
  }
  if (notRestorable.length > 0) {
    lines.push(
      "⚠️ 下列已逾期期限**不适用**上述恢复规定（专利法实施细则第6条第5款把专利法第24、29、42、74条的期限排除在外）：" +
        `${notRestorable.map(entry => `${entry.label}（${entry.restorationExcluded ?? ""}）`).join("；")}。`,
      "",
    );
  }

  return lines.join("\n").trimEnd();
}
