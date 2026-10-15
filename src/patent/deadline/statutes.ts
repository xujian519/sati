/**
 * src/patent/deadline/statutes — 期限类型契约与求值器。
 *
 * **类型都在本文件**（对外契约面）；**规则表条目在 `deadline-rules.ts`**——拆开是因为单文件有
 * 800 行上限，而规则表条目连同其逐条法条注释本身就有 500 余行。依赖是单向的：
 * `statutes`（类型 + 求值 + 装配）→ `deadline-rules`（条目构造）；后者只用 `import type` 回指
 * 本文件的类型，故运行时无环。
 *
 * ## 三条不可让步的纪律
 *
 * 1. **以通知送达起算的期限，绝不从申请日近似**：授权、驳回、审查意见的期限从**送达**起算。
 *    没有送达记录就报 `pending` 并**指名缺哪一个输入**，绝不拿「申请日起固定年数」顶上。
 * 2. **优先权输入双向 fail-loud**：主张优先权却没有优先权日、或有优先权日却声明不主张，都是
 *    矛盾记录，静默取一个会让起算点悄悄改变。
 * 3. **两个末端日期都要给**：`rawDueDate`（期限本体届满日）与 `dueDate`（顺延后）始终同时给，
 *    否则「顺延生效了吗」无法被机械检查。
 *
 * ## 求值器入口的值级日期断言
 *
 * dsh 的日期校验只在 `parseCalendarDate` 里对**字符串**生效；绕过解析器直接构造
 * `{ year: NaN, … }` 会算出 NaN 届满日 + `status: "normal"` 的「看起来正常」结果。
 * `assertQuery` 在求值器入口对已构造的值再断言一次（Sati 新增）。
 *
 * 三处相对 dsh 的收紧／增补（双口径申请费、`requiresFullCalendar` 分型 + 下界、恢复排除标注）
 * 及其理由写在 `deadline-rules.ts` 的模块头。
 */

import { assertCalendarDate, type CalendarDate } from "./calendar.js";
import type { DeliveryRequest } from "./delivery.js";
import { buildDeadlineItems, DeadlineQueryError, type DeadlineItem } from "./deadline-rules.js";
import type { WorkCalendar } from "./work-calendar.js";

export { DeadlineQueryError, UNCOVERED_YEAR_CAVEAT_PREFIX } from "./deadline-rules.js";

/** 专利类型，决定适用的期限长度。 */
export type PatentKind = "invention" | "utility-model" | "design";

/**
 * 是否对报告出的届满日应用细则第 5 条的休假日顺延。
 *
 * `apply` 是法定读法也是默认；`omit` 只报期限自身的届满日、不顺延，适用于「记录期限本身」
 * （如专利权期限届满日）而非「最后一天要办事」的场景。
 */
export type RestDayRule = "apply" | "omit";

/** 一件案子里会收到、并由其送达启动一段期限的通知。 */
export type NoticeKind =
  | "acceptance-notice"
  | "office-action-first"
  | "office-action-subsequent"
  | "rejection-decision"
  | "grant-notice"
  | "reexamination-notice";

/** 一份通知及其送达情形。 */
export type NoticeInput = {
  kind: NoticeKind;
  delivery: DeliveryRequest;
  /** 通知书自身指定的期限月数，覆盖通常长度。 */
  designatedMonths?: number;
};

/** 年费的滞纳窗口（细则第 115 条）。字段同时供 A4 官费计价读取。 */
export type LatePaymentWindow = {
  /** 应缴年费期满日。 */
  from: string;
  /** 6 个月滞纳期的最后一日。 */
  to: string;
  /** 滞纳期长度（月）。 */
  months: number;
  /** 每超 1 个月加收的比例（相对当年全额年费）。 */
  monthlyRate: number;
  legalBasis: string;
  note: string;
};

/** 求值所需的全部案件输入。 */
export type DeadlineQuery = {
  kind: PatentKind;
  /** 申请日；国际申请为其国际申请日。 */
  filingDate: CalendarDate;
  /**
   * 是否主张优先权。由经办人/当事人**显式**给出，绝不从「有没有填优先权日」推断——否则一条
   * 半填的记录会让起算点悄悄改变。
   */
  claimsPriority: boolean;
  /** 最早优先权日；`claimsPriority` 为 true 时必需。 */
  priorityDate?: CalendarDate;
  /** 是否为 PCT 进入中国国家阶段的申请。 */
  isPctNationalPhase?: boolean;
  /** 授权公告日（决定授权当年所在专利年度）。 */
  authorizationPublicationDate?: CalendarDate;
  /** 本案收到的、会启动期限的通知。 */
  notices?: readonly NoticeInput[];
  /** 是否应用细则第 5 条顺延；默认 `apply`。 */
  restDayRule?: RestDayRule;
  /** 出具报告的基准日；由调用方给出，使报告可复现（不读宿主时钟）。 */
  today: CalendarDate;
};

/** 期限的紧迫程度。 */
export type DeadlineStatus = "overdue" | "urgent" | "normal";

/** 顺延口径。 */
export type RollForwardMode = "holiday+weekend" | "weekend-only";

/** 已算出日期的期限。 */
export type ComputedDeadline = {
  id: string;
  label: string;
  legalBasis: string;
  /** 期限本体届满日（顺延前，**始终给出**）。 */
  rawDueDate: string;
  /**
   * 判决届满日（顺延后）。仅当口径完整（`holiday+weekend`）时给出；日历未覆盖该年且本条为
   * **参考性期限**时为 `undefined`，此时只有 {@link dueDateLowerBound}。
   */
  dueDate?: string;
  /** 日历未覆盖时给出的**下界**（仅按周末顺延）。不是判决值，不得据此认定合规。 */
  dueDateLowerBound?: string;
  /** 本条实际使用的顺延口径。 */
  rollForward: RollForwardMode;
  /** 距离 `today` 的剩余天数（负数为已过期）。 */
  daysRemaining: number;
  /** `daysRemaining` 是相对判决届满日还是相对下界算的。 */
  daysRemainingBasis: "dueDate" | "lowerBound";
  status: DeadlineStatus;
  /** 顺延是否真的移动了日期。 */
  rolledForward: boolean;
  /** 本条是否为「最后一天要办事」的期限（决定日历未覆盖时的处置）。 */
  requiresFullCalendar: boolean;
  /** 日历未覆盖年份的机器可读标记，形如 `calendar-uncovered-year:2027`。 */
  calendarCaveat?: string;
  /** 起算规则（送达类期限给出来源）。 */
  triggerBasis?: string;
  /** 送达记录本身需要复核时的提示。 */
  triggerCaveat?: string;
  /** 年费的滞纳窗口。 */
  latePaymentWindow?: LatePaymentWindow;
  /** 年费所属专利年度（细则第 115 条的口径，供 A4 计价同名读取）。 */
  patentYear?: number;
  /** 该期限**不适用**细则第 6 条恢复时的法条依据（空 = 可请求恢复）。 */
  restorationExcluded?: string;
};

/** 无法从给定输入算出的期限。 */
export type PendingDeadline = {
  id: string;
  label: string;
  legalBasis: string;
  /** 仍缺的输入。 */
  requiredInput: string;
  reason: string;
};

/** 期限报告。 */
export type DeadlineReport = {
  computed: ComputedDeadline[];
  pending: PendingDeadline[];
  /** 报告出的届满日所依据的顺延口径。 */
  restDayRule: RestDayRule;
  /** 工作日历已覆盖的年份（升序），供调用方判断降级影响面。 */
  calendarCoveredYears: number[];
};

/** 求值器除案件输入外需要的选项。 */
export type EvaluateOptions = {
  calendar: WorkCalendar;
  /** 届满日距今不超过该天数时标为 `urgent`；属部署策略。 */
  reminderLeadDays: number;
};

/**
 * 求值入口。
 * @param query - 案件日期、通知与基准日。
 * @param options - 工作日历与提醒策略。
 * @returns 已算出的期限（按日期升序）与仍需输入的期限。
 * @throws DeadlineQueryError 当输入自相矛盾。
 * @throws CalendarDateError 当日期值不是真实存在的日期（含绕过解析器构造的坏值）。
 */
export function evaluateDeadlines(query: DeadlineQuery, options: EvaluateOptions): DeadlineReport {
  assertQuery(query);
  return assemble(buildDeadlineItems(query, options), query, options);
}

/**
 * 校验案件输入：日期值必须真实、优先权输入不得自相矛盾。
 *
 * 日期校验在这里做**值级**断言，而不是只依赖 `parseCalendarDate`——后者只对字符串生效，绕过
 * 解析器直接构造的 NaN 日期会算出一个「看起来正常」的 `status: "normal"`（dsh 的已知边界）。
 * @param query - 案件输入。
 */
function assertQuery(query: DeadlineQuery): void {
  assertCalendarDate(query.filingDate, "filingDate");
  assertCalendarDate(query.today, "today");
  if (query.priorityDate !== undefined) assertCalendarDate(query.priorityDate, "priorityDate");
  if (query.authorizationPublicationDate !== undefined) {
    assertCalendarDate(query.authorizationPublicationDate, "authorizationPublicationDate");
  }
  if (query.claimsPriority && query.priorityDate === undefined) {
    throw new DeadlineQueryError(
      "已声明本案主张优先权（claimsPriority: true），但未提供优先权日（priorityDate）：" +
        "实审请求等期限自优先权日起算，缺该日期无法计算。",
    );
  }
  if (!query.claimsPriority && query.priorityDate !== undefined) {
    throw new DeadlineQueryError(
      "本案声明不主张优先权（claimsPriority: false），却提供了优先权日（priorityDate）：" +
        "两者矛盾，请按案卷事实改其一。",
    );
  }
}

/**
 * 拆分并按日期升序排列。
 * @param items - 构造出的条目。
 * @param query - 案件输入（记录顺延口径）。
 * @param options - 求值选项（记录日历覆盖年份）。
 * @returns 报告。
 */
function assemble(items: readonly DeadlineItem[], query: DeadlineQuery, options: EvaluateOptions): DeadlineReport {
  const computed = items.filter(item => item.kind === "computed").map(item => item.value as ComputedDeadline);
  const uncomputed = items
    .filter(item => item.kind === "pending")
    .map(item => item.value as PendingDeadline)
    .sort((left, right) => left.id.localeCompare(right.id));
  computed.sort(
    (left, right) =>
      (left.dueDate ?? left.dueDateLowerBound ?? left.rawDueDate).localeCompare(
        right.dueDate ?? right.dueDateLowerBound ?? right.rawDueDate,
      ) || left.id.localeCompare(right.id),
  );
  return {
    computed,
    pending: uncomputed,
    restDayRule: query.restDayRule ?? "apply",
    calendarCoveredYears: options.calendar.coveredYears,
  };
}

/**
 * 专利类型的中文名。
 * @param kind - 专利类型。
 * @returns 中文名。
 */
export function describePatentKind(kind: PatentKind): string {
  switch (kind) {
    case "invention":
      return "发明专利";
    case "utility-model":
      return "实用新型专利";
    case "design":
      return "外观设计专利";
  }
}
