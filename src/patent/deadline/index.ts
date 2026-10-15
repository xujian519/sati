/**
 * src/patent/deadline — 中国专利法定期限与指定期限（A3）。
 *
 * 分层（自下而上，每层只依赖其下）：
 *
 * | 模块 | 职责 |
 * |---|---|
 * | `calendar` | 民事日历日期与算术（月/年进位、月末规则） |
 * | `period` | 细则第 5 条的期限算术（起算日不计入） |
 * | `work-calendar` | 节假日资产装载 + 休假日顺延（含降级口径与覆盖门禁） |
 * | `delivery` | 送达日认定（细则第 4 条；电子送达不加 15 日） |
 * | `statutes` | 期限规则表 + 求值器 |
 * | `report` | 模型可读的报告渲染 |
 *
 * 工具面在 `src/tool/builtin/patentDeadlines.ts`（与 docket 等专利模块同构：纯逻辑在此，
 * 工具注册在 tool 层）。
 */

export {
  addCalendarDays,
  addCalendarMonths,
  assertCalendarDate,
  CalendarDateError,
  compareCalendarDates,
  daysBetween,
  daysInMonth,
  formatCalendarDate,
  parseCalendarDate,
  weekday,
  type CalendarDate,
} from "./calendar.js";

export { describePeriod, PeriodError, periodEnd, type Period, type PeriodUnit } from "./period.js";

export {
  assertCalendarFreshness,
  CALENDAR_FILE_NAME,
  clearWorkCalendarCache,
  DEFAULT_FRESHNESS_POLICY,
  loadWorkCalendar,
  parseWorkCalendar,
  WorkCalendar,
  WorkCalendarCoverageError,
  WorkCalendarError,
  type CalendarFreshnessPolicy,
  type RollForwardResult,
  type WorkCalendarYear,
} from "./work-calendar.js";

export {
  DeliveryInputError,
  resolveDeliveryDate,
  resolveDeliveryMode,
  type DeliveryDate,
  type DeliveryInput,
  type DeliveryMode,
  type DeliveryRequest,
} from "./delivery.js";

export {
  DeadlineQueryError,
  describePatentKind,
  evaluateDeadlines,
  UNCOVERED_YEAR_CAVEAT_PREFIX,
  type ComputedDeadline,
  type DeadlineQuery,
  type DeadlineReport,
  type DeadlineStatus,
  type EvaluateOptions,
  type LatePaymentWindow,
  type NoticeInput,
  type NoticeKind,
  type PatentKind,
  type PendingDeadline,
  type RestDayRule,
  type RollForwardMode,
} from "./statutes.js";

export { renderDeadlineReport, type DeadlineReportMeta } from "./report.js";
