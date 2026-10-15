/**
 * src/patent/deadline/deadline-rules — 法定期限规则表（每条与它的法条依据写在一起）。
 *
 * 期限是**外部规范**（专利法 / 实施细则 / 审查指南），不是部署偏好，所以每一条都与它的法条依据
 * 写在一起。部署可以调的（多早提醒）是配置字段，不是期限。
 *
 * 本文件自 `statutes.ts` 拆出（单文件 800 行上限）。**类型契约与求值入口在 `statutes.ts`**，
 * 这里只负责把条目构造出来。
 *
 * ## 三处 Sati 相对 dsh 的收紧／增补（每条都有理由）
 *
 * - **双口径**（细则第 112 条把申请费写成「自申请日起 2 个月内**或者**在收到受理通知书之日起
 *   15 日内」）：dsh 只给前者。实务上两个口径常一个已过、一个仍在跑，只报一个会误判「已逾期」。
 *   故两条**分别成条**同时输出。
 * - **`requiresFullCalendar` 分型 + 下界**：dsh 没有这个字段，其后果是「日历未覆盖年份」时整条
 *   期限按未顺延呈现而看不出未判定。Sati 的做法是**降级为下界**：期限本体届满日始终给出，顺延
 *   无法判定时另给 `dueDateLowerBound`（仅按周末顺延）并标注——下界是「真实届满日不早于此」的
 *   **安全保守值**，按下界办事一定不晚。`requiresFullCalendar` 决定报告**措辞强度**。
 *
 *   ⚠️ 这与原计划的「要办事的期限在日历未覆盖时降级为 `pending`」不同——**实测推翻了该假设**：
 *   日历只能覆盖当年+次年（次年安排在发布前客观不存在），而实审请求等期限动辄落在 3 年后，按
 *   原分型会让绝大多数期限变成 pending、连确定的 `rawDueDate` 都拿不到。`pending` 现在只表示
 *   **缺案件事实**（缺通知送达、缺授权公告日），与「缺年度日历」这一**资产**问题分开。
 * - **恢复排除**：细则第 6 条第 5 款明确「第一款和第二款的规定**不适用**专利法第二十四条、
 *   第二十九条、第四十二条、第七十四条规定的期限」。故优先权期限与专利权期限标
 *   `restorationExcluded`——否则报告会暗示「逾期还能恢复」。
 *
 * ## 法条核验
 *
 * 规则表逐条对照过 `knowledge.db` 的法规全文（专利法 82 条 / 实施细则 149 条，`source='raw'`），
 * 核验结果见 `docs/notes/implemented/2026-10-15-patent-deadlines.md`。未收录的条目一律不做，
 * 不靠猜补全。
 */

import {
  addCalendarMonths,
  compareCalendarDates,
  daysBetween,
  formatCalendarDate,
  type CalendarDate,
} from "./calendar.js";
import { resolveDeliveryDate } from "./delivery.js";
import { periodEnd, type Period } from "./period.js";
import { WorkCalendarCoverageError } from "./work-calendar.js";
import type {
  ComputedDeadline,
  DeadlineQuery,
  DeadlineStatus,
  EvaluateOptions,
  LatePaymentWindow,
  NoticeInput,
  NoticeKind,
  PendingDeadline,
  RollForwardMode,
} from "./statutes.js";

/** 求值输入自相矛盾时抛出。 */
export class DeadlineQueryError extends Error {
  /**
   * @param message - 矛盾在哪。
   */
  constructor(message: string) {
    super(message);
    this.name = "DeadlineQueryError";
  }
}

/** 日历未覆盖年份的机器可读前缀。 */
export const UNCOVERED_YEAR_CAVEAT_PREFIX = "calendar-uncovered-year:";

/**
 * 一件案子里可能出现多次的通知类型，每一次各自启动一段期限。
 *
 * 一件案子常收到多份后续审查意见通知书，复审也可能出多份复审通知书；每一份都是独立的起算
 * 事件，故报告为每一份出一行。其余类型一件案子只发一次，重复记录是**数据错误**——静默取一份
 * 会掩盖另一份，故直接拒绝。
 */
const REPEATABLE_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>([
  "office-action-subsequent",
  "reexamination-notice",
]);

/** 条目构造时的公共字段（规则表内部使用）。 */
export type EntryBase = {
  id: string;
  label: string;
  legalBasis: string;
  query: DeadlineQuery;
  options: EvaluateOptions;
  /** 是否为「最后一天要办事」的期限；默认 true。 */
  requiresFullCalendar?: boolean;
  triggerBasis?: string;
  triggerCaveat?: string;
  latePaymentWindow?: LatePaymentWindow;
  patentYear?: number;
  restorationExcluded?: string;
};

/** 规则表里的一条（已算出日期或仍需输入）。 */
export type DeadlineItem = { kind: "computed"; value: ComputedDeadline } | { kind: "pending"; value: PendingDeadline };

/**
 * 构造本案的全部期限条目（规则表的执行入口）。
 *
 * 只做「按族收集」，不做排序与拆分——那是 `assemble` 的事。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 条目列表（已算出或仍需输入）。
 * @throws DeadlineQueryError 当一次性通知类型出现重复记录。
 */
export function buildDeadlineItems(query: DeadlineQuery, options: EvaluateOptions): DeadlineItem[] {
  const notices = indexNotices(query.notices ?? []);
  return [
    ...priorityItems(query, options),
    ...applicationFeeItems(notices, query, options),
    ...substantiveExamRequestItems(query, options),
    ...registrationItems(notices, query, options),
    ...patentTermItems(query, options),
    ...annualFeeItems(query, options),
    ...pctNationalEntryItems(query, options),
    ...noticeDrivenItems(notices, query, options),
  ];
}

/**
 * 优先权族：可就相同主题提出后续申请的窗口、其恢复请求，以及（主张优先权时）增加或改正优先权要求。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 优先权相关条目。
 */
function priorityItems(query: DeadlineQuery, options: EvaluateOptions): DeadlineItem[] {
  const filing = query.filingDate;
  const priority = query.priorityDate;
  const items: DeadlineItem[] = [];

  // ── 专利法第29条：优先权期限。发明/实用新型 12 个月，外观设计 6 个月。
  const priorityMonths = query.kind === "design" ? 6 : 12;
  items.push(
    fromPeriod({
      base: {
        id: "priority-window",
        label: `优先权期限（可就相同主题提出后续申请并主张优先权，${String(priorityMonths)}个月自本申请日起算）`,
        legalBasis: query.kind === "design" ? "专利法第29条第2款" : "专利法第29条第1款",
        query,
        options,
        // 细则第6条第5款：优先权期限不适用恢复。
        restorationExcluded: "专利法实施细则第6条第5款（不适用专利法第29条规定的期限）",
      },
      start: filing,
      period: { unit: "month", count: priorityMonths },
    }),
  );

  // ── 细则第36条：优先权期限届满后 2 个月内可请求恢复优先权（有正当理由）。
  items.push(
    fromPeriod({
      base: {
        id: "priority-restoration",
        label: "请求恢复优先权（有正当理由且在优先权期限届满后2个月内）",
        legalBasis: "专利法实施细则第36条",
        query,
        options,
      },
      start: periodEnd(filing, { unit: "month", count: priorityMonths }),
      period: { unit: "month", count: 2 },
    }),
  );

  // ── 细则第37条：增加或改正优先权要求，自优先权日起16个月与自申请日起4个月取较晚者。
  if (query.claimsPriority && priority !== undefined) {
    const fromPriority = periodEnd(priority, { unit: "month", count: 16 });
    const fromFiling = periodEnd(filing, { unit: "month", count: 4 });
    items.push(
      fromDate({
        base: {
          id: "priority-addition-or-correction",
          label: "请求增加或改正优先权要求（自优先权日起16个月与自申请日起4个月，以较晚届满者为准）",
          legalBasis: "专利法实施细则第37条",
          query,
          options,
        },
        due: compareCalendarDates(fromPriority, fromFiling) >= 0 ? fromPriority : fromFiling,
      }),
    );
  }

  return items;
}

/**
 * 申请费：细则第 112 条是**双起算点**，两条分别输出。
 *
 * 原文：「申请人应当自申请日起 2 个月内**或者**在收到受理通知书之日起 15 日内缴纳申请费、
 * 公布印刷费和必要的申请附加费。」
 *
 * 只报一个口径会误判：实测（2026-10 期限盘点）存在 15 日口径已届满、2 个月口径仍在跑的案子。
 * 两条同时给出，由使用者判断哪一条在跑。
 * @param notices - 已记录的通知。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 两条申请费期限（通知口径未记录送达时为 pending）。
 */
function applicationFeeItems(
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
  query: DeadlineQuery,
  options: EvaluateOptions,
): DeadlineItem[] {
  const items: DeadlineItem[] = [
    fromPeriod({
      base: {
        id: "application-fee-from-filing",
        label: "缴纳申请费、公布印刷费及必要的申请附加费（口径一：自申请日起2个月）",
        legalBasis: "专利法实施细则第112条",
        query,
        options,
      },
      start: query.filingDate,
      period: { unit: "month", count: 2 },
    }),
  ];

  // 口径二自受理通知书送达起 15 日。未记录送达时不报「申请日起的固定天数」顶上，而是 pending。
  items.push(
    ...fromNotices({
      id: "application-fee-from-notice",
      label: "缴纳申请费、公布印刷费及必要的申请附加费（口径二：自收到受理通知书之日起15日内）",
      legalBasis: "专利法实施细则第112条",
      noticeKind: "acceptance-notice",
      absentReason:
        "该口径自收到受理通知书之日起算，本查询未提供受理通知书的送达记录。口径一（自申请日起2个月）不受影响，已单独列出。",
      period: { unit: "day", count: 15 },
      notices,
      query,
      options,
    }),
  );

  return items;
}

/**
 * 实质审查请求：仅发明专利有，主张优先权时自**优先权日**起算（专利法第 35 条，也是实践中审查员采用的口径）。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 请求条目；实用新型与外观设计返回空。
 */
function substantiveExamRequestItems(query: DeadlineQuery, options: EvaluateOptions): DeadlineItem[] {
  if (query.kind !== "invention") return [];
  const priority = query.priorityDate;
  const start = query.claimsPriority && priority !== undefined ? priority : query.filingDate;
  const startLabel = start === query.filingDate ? "申请日" : "优先权日";
  return [
    fromPeriod({
      base: {
        id: "substantive-exam-request",
        label: `请求实质审查并缴纳审查费（自${startLabel}起3年）`,
        legalBasis: "专利法第35条",
        query,
        options,
      },
      start,
      period: { unit: "year", count: 3 },
    }),
  ];
}

/**
 * 办登与分案：都自**授权通知送达**起算，未记录该通知时 pending。
 * @param notices - 已记录的通知。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 两条期限（或两条 pending）。
 */
function registrationItems(
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
  query: DeadlineQuery,
  options: EvaluateOptions,
): DeadlineItem[] {
  const grantNotice = notices.get("grant-notice")?.[0];
  if (grantNotice === undefined) {
    return [
      pending({
        id: "registration",
        label: "办理登记手续并缴纳授予专利权当年年费",
        legalBasis: "专利法实施细则第60条第1款、第114条",
        requiredInput: "grant-notice（授权通知的送达记录）",
        reason: "该期限自收到授予专利权的通知之日起算；未记录该通知的送达日即无法计算，不以申请日起算的固定年数替代。",
      }),
      pending({
        id: "divisional-application",
        label: "提出分案申请（须在办理登记手续期限届满前）",
        legalBasis: "专利法实施细则第48条、第60条第1款",
        requiredInput: "grant-notice（授权通知的送达记录）",
        reason: "分案申请须在办理登记手续期限届满前提出，而该期限自收到授权通知之日起算。",
      }),
    ];
  }
  const grant = resolveDeliveryDate(grantNotice.delivery);
  const shared = {
    query,
    options,
    triggerBasis: grant.basis,
    ...(grant.caveat !== undefined ? { triggerCaveat: grant.caveat } : {}),
  };
  return [
    fromPeriod({
      base: {
        id: "registration",
        // 细则第114条把授权当年年费并入办登；印花税已非现行收费标准收取的费种。
        label: "办理登记手续并缴纳授予专利权当年年费（自收到授权通知之日起2个月）",
        legalBasis: "专利法实施细则第60条第1款、第114条",
        ...shared,
      },
      start: grant.date,
      period: { unit: "month", count: 2 },
    }),
    fromPeriod({
      base: {
        id: "divisional-application",
        label: "提出分案申请（自收到授权通知之日起2个月，与办登期限同期届满）",
        legalBasis: "专利法实施细则第48条、第60条第1款",
        ...shared,
      },
      start: grant.date,
      period: { unit: "month", count: 2 },
    }),
  ];
}

/**
 * 专利权期限：始终自申请日起算（专利法第 42 条第 1 款）。
 *
 * `requiresFullCalendar: false`——它是**参考性**日期（权利何时终止），不是「最后一天要办事」。
 * 年度节假日安排缺失时不该整条降级为 pending，故给「仅按周末顺延」的下界。同日也标出恢复排除。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 专利权期限条目。
 */
function patentTermItems(query: DeadlineQuery, options: EvaluateOptions): DeadlineItem[] {
  const termYears = query.kind === "invention" ? 20 : query.kind === "utility-model" ? 10 : 15;
  return [
    fromPeriod({
      base: {
        id: "patent-term",
        label: `专利权期限届满（${String(termYears)}年，自申请日起算）`,
        legalBasis: "专利法第42条第1款",
        query,
        options,
        requiresFullCalendar: false,
        restorationExcluded: "专利法实施细则第6条第5款（不适用专利法第42条规定的期限）",
      },
      start: query.filingDate,
      period: { unit: "year", count: termYears },
    }),
  ];
}

/**
 * 年费：细则第 115 条，「授予专利权当年以后的年费应当在上一年度期满前缴纳」。
 *
 * 故**第 N 年度年费的缴费期限届满日 = 申请日 + (N−1)×12 个月**（= 第 N−1 年度期满日）。
 * ⚠️ 这与「第 N 年度本身的期满日 = 申请日 + N×12 个月」不是同一个日期，两者差一年；本模块
 * 报的是**缴费期限**。`patentYear` 字段把年度序号显式带出，供 A4 计价同名字段读取。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 年费条目，或未给授权公告日时的 pending。
 */
function annualFeeItems(query: DeadlineQuery, options: EvaluateOptions): DeadlineItem[] {
  const filing = query.filingDate;
  const grant = query.authorizationPublicationDate;
  if (grant === undefined) {
    return [
      pending({
        id: "annual-fee",
        label: "缴纳授予专利权当年以后各年度的年费",
        legalBasis: "专利法实施细则第115条、第114条",
        requiredInput: "authorizationPublicationDate（授权公告日）",
        reason:
          "费用年度取决于授予专利权当年的专利年度：授权当年年费在办理登记手续时缴纳，以后年度年费" +
          "在上一年度期满前缴纳。未提供授权公告日即无法确定年度序号。",
      }),
    ];
  }
  const grantedYear = patentYearOf(filing, grant);
  // 只报「基准日之后两年」这个窗口内的年度——再远没有行动价值，且会把报告淹掉。
  const horizon = periodEnd(query.today, { unit: "year", count: 2 });
  const lastYear = Math.max(grantedYear + 1, patentYearOf(filing, horizon));
  const items: DeadlineItem[] = [];
  for (let year = grantedYear + 1; year <= lastYear; year++) {
    const due = addCalendarMonths(filing, (year - 1) * 12);
    const windowEnd = periodEnd(due, { unit: "month", count: 6 });
    items.push(
      fromDate({
        base: {
          id: `annual-fee-${String(year)}`,
          label: `缴纳第${String(year)}年度年费（授予专利权当年以后的年费应在上一年度期满前缴纳）`,
          legalBasis: "专利法实施细则第115条",
          query,
          options,
          patentYear: year,
          latePaymentWindow: {
            from: formatCalendarDate(due),
            to: formatCalendarDate(windowEnd),
            months: 6,
            monthlyRate: 0.05,
            legalBasis: "专利法实施细则第115条",
            note:
              "未缴或者未缴足的，可在应缴年费期满之日起6个月内补缴，同时缴纳滞纳金" +
              "（每超过规定的缴费时间1个月，加收当年全额年费的5%）；期满未缴纳的，" +
              "专利权自应当缴纳年费期满之日起终止。",
          },
        },
        due,
      }),
    );
  }
  return items;
}

/**
 * PCT 进入中国国家阶段：细则第 120 条，自优先权日起 30 个月，缴宽限费后可延至 32 个月。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 两条条目；非国家阶段申请返回空。
 */
function pctNationalEntryItems(query: DeadlineQuery, options: EvaluateOptions): DeadlineItem[] {
  if (query.isPctNationalPhase !== true) return [];
  const base = query.priorityDate ?? query.filingDate;
  const baseLabel = query.priorityDate !== undefined ? "优先权日" : "国际申请日（未主张优先权）";
  return [
    fromPeriod({
      base: {
        id: "pct-national-entry",
        label: `办理进入中国国家阶段手续（自${baseLabel}起30个月内）`,
        legalBasis: "专利法实施细则第120条",
        query,
        options,
      },
      start: base,
      period: { unit: "month", count: 30 },
    }),
    fromPeriod({
      base: {
        id: "pct-national-entry-grace",
        label: `宽限期内办理进入中国国家阶段手续（自${baseLabel}起32个月内，须缴宽限费）`,
        legalBasis: "专利法实施细则第120条",
        query,
        options,
      },
      start: base,
      period: { unit: "month", count: 32 },
    }),
  ];
}

/** 一条以通知送达起算的期限定义。 */
type NoticePeriodSpec = {
  id: string;
  label: string;
  legalBasis: string;
  noticeKind: NoticeKind;
  /** 案件未记录该通知时，说明为什么无法计算。 */
  absentReason: string;
  /** 通知书未指定时采用的期限长度。 */
  period: Period;
};

/**
 * 以通知送达起算的期限表。
 *
 * 只收录**期限长度有规范依据**的条目。答复期限的长度来自《专利审查指南》第五部分第七章
 * （一通 4 个月、后续指定一般 2 个月），且通知书可另行指定——`designatedMonths` 覆盖生效。
 */
const NOTICE_PERIOD_SPECS: readonly NoticePeriodSpec[] = [
  {
    id: "reexamination-request",
    label: "请求复审（自收到驳回决定之日起3个月）",
    legalBasis: "专利法第41条第1款",
    noticeKind: "rejection-decision",
    absentReason: "需要驳回决定的送达记录，本查询未提供该通知。",
    period: { unit: "month", count: 3 },
  },
  {
    id: "oa-response-first",
    label: "答复第一次审查意见通知书（指定期限，实质审查程序中为4个月）",
    legalBasis: "专利审查指南第五部分第七章（指定期限）",
    noticeKind: "office-action-first",
    absentReason: "需要第一次审查意见通知书的送达记录，本查询未提供该通知。",
    period: { unit: "month", count: 4 },
  },
  {
    id: "oa-response-subsequent",
    label: "答复后续审查意见通知书（指定期限一般为2个月，以通知书指定为准）",
    legalBasis: "专利审查指南第五部分第七章（指定期限）",
    noticeKind: "office-action-subsequent",
    absentReason: "需要后续审查意见通知书的送达记录，本查询未提供该通知。",
    period: { unit: "month", count: 2 },
  },
  {
    id: "reexamination-deficiency-response",
    label: "答复复审通知书（指定期限，通常为2个月，以通知书指定为准）",
    legalBasis: "专利法实施细则第67条",
    noticeKind: "reexamination-notice",
    absentReason: "需要复审通知书的送达记录，本查询未提供该通知。",
    period: { unit: "month", count: 2 },
  },
];

/**
 * 生成以通知送达起算的期限：每一份记录在案的通知各出一行，未记录则出一行 pending。
 * @param notices - 按类型索引的通知。
 * @param query - 案件输入。
 * @param options - 日历与提醒策略。
 * @returns 计算出的条目或 pending。
 */
function noticeDrivenItems(
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
  query: DeadlineQuery,
  options: EvaluateOptions,
): DeadlineItem[] {
  return NOTICE_PERIOD_SPECS.flatMap(spec =>
    fromNotices({
      id: spec.id,
      label: spec.label,
      legalBasis: spec.legalBasis,
      noticeKind: spec.noticeKind,
      absentReason: spec.absentReason,
      period: spec.period,
      notices,
      query,
      options,
    }),
  );
}

/**
 * 某日期落在自申请日起算的第几个专利年度（1 起）。
 * @param filingDate - 起算第 1 年的申请日。
 * @param date - 待定位的日期。
 * @returns 专利年度序号。
 */
function patentYearOf(filingDate: CalendarDate, date: CalendarDate): number {
  let year = 1;
  // 一个专利年度最多 366 天；上界同时防止畸形输入对把循环卡死。
  while (year < 200 && compareCalendarDates(addCalendarMonths(filingDate, year * 12), date) <= 0) {
    year++;
  }
  return year;
}

/** 由「起算日 + 期限」构造条目。 */
function fromPeriod(args: { base: EntryBase; start: CalendarDate; period: Period }): DeadlineItem {
  return finish(args.base, periodEnd(args.start, args.period));
}

/** 由已知届满日构造条目。 */
function fromDate(args: { base: EntryBase; due: CalendarDate }): DeadlineItem {
  return finish(args.base, args.due);
}

/**
 * 按类型索引通知；一次性类型的重复记录直接拒绝。
 * @param supplied - 案件记录的通知。
 * @returns 按类型分组的通知。
 * @throws DeadlineQueryError 当只发一次的类型出现两条记录。
 */
function indexNotices(supplied: readonly NoticeInput[]): ReadonlyMap<NoticeKind, readonly NoticeInput[]> {
  const byKind = new Map<NoticeKind, NoticeInput[]>();
  for (const notice of supplied) {
    const list = byKind.get(notice.kind);
    if (list === undefined) {
      byKind.set(notice.kind, [notice]);
      continue;
    }
    if (!REPEATABLE_NOTICE_KINDS.has(notice.kind)) {
      throw new DeadlineQueryError(
        `通知书记录重复：${notice.kind} 在一件案子里只有一份，收到两份记录时无法确定以哪一份为准。` +
          "请核对通知书，或把多份记录合并为实际送达情形后的那一份。",
      );
    }
    list.push(notice);
  }
  return byKind;
}

/**
 * 由通知送达起算构造期限；可重复类型为每一份通知各出一行。
 * @param args - 条目定义与通知索引。
 * @returns 计算出的条目，或一行 pending。
 */
function fromNotices(args: {
  id: string;
  label: string;
  legalBasis: string;
  noticeKind: NoticeKind;
  absentReason: string;
  period: Period;
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>;
  query: DeadlineQuery;
  options: EvaluateOptions;
}): DeadlineItem[] {
  const recorded = args.notices.get(args.noticeKind) ?? [];
  if (recorded.length === 0) {
    return [
      pending({
        id: args.id,
        label: args.label,
        legalBasis: args.legalBasis,
        requiredInput: `${args.noticeKind}（通知的送达记录）`,
        reason: args.absentReason,
      }),
    ];
  }
  return recorded.map((notice, index) => {
    const id = index === 0 ? args.id : `${args.id}-${String(index + 1)}`;
    const resolved = resolveDeliveryDate(notice.delivery);
    const designated =
      notice.designatedMonths !== undefined ? `；通知书指定期限 ${String(notice.designatedMonths)} 个月` : "";
    const label = recorded.length === 1 ? args.label : `${args.label}（第 ${String(index + 1)} 份通知）`;
    return fromPeriod({
      base: {
        id,
        label,
        legalBasis: args.legalBasis,
        query: args.query,
        options: args.options,
        triggerBasis: `${resolved.basis}${designated}`,
        ...(resolved.caveat !== undefined ? { triggerCaveat: resolved.caveat } : {}),
      },
      start: resolved.date,
      period: {
        unit: notice.designatedMonths !== undefined ? "month" : args.period.unit,
        count: notice.designatedMonths ?? args.period.count,
      },
    });
  });
}

/**
 * 汇总一条已算出的期限：保留期限本体届满日、按口径顺延、并据以判定状态。
 *
 * 日历未覆盖年份时分两种处置（见模块头的 `requiresFullCalendar` 说明）：
 * 要办事的期限 → 降级为 pending（`dueDate` 不存在，法律上没有判决值）；参考性期限 → 给出
 * `dueDateLowerBound`（仅按周末顺延）并标明是下界。
 * @param base - 条目的身份、法条依据、起算依据与查询输入。
 * @param due - 期限本体届满日。
 * @returns 条目（可能因日历未覆盖而变成 pending）。
 */
function finish(base: EntryBase, due: CalendarDate): DeadlineItem {
  const requiresFullCalendar = base.requiresFullCalendar ?? true;
  const rule = base.query.restDayRule ?? "apply";
  const raw = formatCalendarDate(due);

  let dueDate: CalendarDate | undefined = due;
  let lowerBound: CalendarDate | undefined;
  let mode: RollForwardMode = "holiday+weekend";
  let rolledForward = false;
  let calendarCaveat: string | undefined;

  if (rule === "apply") {
    try {
      const rolled = base.options.calendar.rollForward(due);
      dueDate = rolled.date;
      rolledForward = rolled.rolled;
    } catch (error) {
      if (!(error instanceof WorkCalendarCoverageError)) throw error;
      calendarCaveat = `${UNCOVERED_YEAR_CAVEAT_PREFIX}${String(error.year)}`;
      // 顺延无法判定（该年节假日安排未装载）：退回「仅按周末顺延」的降级口径，作为**下界**给出。
      //
      // 为什么不整条降级为 pending（原计划的分型）：期限**本体**届满日是确定的，而下界是
      // 「真实届满日不早于此」的**安全保守值**——按下界办事一定不晚。什么都不给反而会让人自己
      // 心算，那才是真风险。分型保留在 `requiresFullCalendar` 里，用于报告**措辞强度**：
      // 要办事的期限（true）必须显著警告该日期未经顺延判定，参考性期限（false）普通标注即可。
      const weekend = base.options.calendar.rollForwardWeekendOnly(due);
      lowerBound = weekend.date;
      dueDate = undefined;
      mode = "weekend-only";
      rolledForward = weekend.rolled;
    }
  } else {
    mode = "holiday+weekend";
    rolledForward = false;
  }

  const basisDate = dueDate ?? lowerBound ?? due;
  const daysRemaining = daysBetween(base.query.today, basisDate);
  const status: DeadlineStatus =
    daysRemaining < 0 ? "overdue" : daysRemaining <= base.options.reminderLeadDays ? "urgent" : "normal";

  return {
    kind: "computed",
    value: {
      id: base.id,
      label: base.label,
      legalBasis: base.legalBasis,
      rawDueDate: raw,
      ...(dueDate !== undefined ? { dueDate: formatCalendarDate(dueDate) } : {}),
      ...(lowerBound !== undefined ? { dueDateLowerBound: formatCalendarDate(lowerBound) } : {}),
      rollForward: mode,
      daysRemaining,
      daysRemainingBasis: dueDate !== undefined ? "dueDate" : "lowerBound",
      status,
      rolledForward,
      requiresFullCalendar,
      ...(calendarCaveat !== undefined ? { calendarCaveat } : {}),
      ...(base.triggerBasis !== undefined ? { triggerBasis: base.triggerBasis } : {}),
      ...(base.triggerCaveat !== undefined ? { triggerCaveat: base.triggerCaveat } : {}),
      ...(base.latePaymentWindow !== undefined ? { latePaymentWindow: base.latePaymentWindow } : {}),
      ...(base.patentYear !== undefined ? { patentYear: base.patentYear } : {}),
      ...(base.restorationExcluded !== undefined ? { restorationExcluded: base.restorationExcluded } : {}),
    },
  };
}

/** 构造一条 pending。 */
function pending(value: PendingDeadline): DeadlineItem {
  return { kind: "pending", value };
}
