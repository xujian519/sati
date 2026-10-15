/**
 * src/patent/deadline/period — 期限算术（专利法实施细则第 5 条）。
 *
 * 原文：「专利法和本细则规定的各种期限开始的当日不计算在期限内，自下一日开始计算。期限以
 * 年或者月计算的，以其最后一月的相应日为期限届满日；该月无相应日的，以该月最后一日为期限
 * 届满日；期限届满日是法定休假日的，以休假日后的第一个工作日为期限届满日。」
 *
 * 本条只做前两句（起算日不计入 + 相应日/月末规则）；第三句的**休假日顺延**在
 * `work-calendar.ts`（需要年度节假日安排，是资产、不是算术）。
 */

import { addCalendarDays, addCalendarMonths, type CalendarDate } from "./calendar.js";

/** 期限单位。 */
export type PeriodUnit = "day" | "month" | "year";

/** 一段期限长度。 */
export type Period = {
  unit: PeriodUnit;
  count: number;
};

/** 期限长度不是正整数时抛出。 */
export class PeriodError extends Error {
  /**
   * @param message - 期限哪里不对。
   */
  constructor(message: string) {
    super(message);
    this.name = "PeriodError";
  }
}

/**
 * 计算期限届满日（**未**做休假日顺延）。
 *
 * 起算日当日不计入（细则第 5 条）：N 日期限自 `D` 起算，届满于 `D + N`；N 个月期限届满于
 * N 个月后的相应日（目标月无相应日时取月末）。
 * @param start - 起算日（触发日或送达日）。
 * @param period - 期限长度。
 * @returns 顺延前的期限届满日。
 * @throws PeriodError 当期限长度不是正整数。
 */
export function periodEnd(start: CalendarDate, period: Period): CalendarDate {
  if (!Number.isInteger(period.count) || period.count <= 0) {
    throw new PeriodError(`期限长度必须为正整数: ${String(period.count)}`);
  }
  switch (period.unit) {
    case "day":
      return addCalendarDays(start, period.count);
    case "month":
      return addCalendarMonths(start, period.count);
    case "year":
      return addCalendarMonths(start, period.count * 12);
  }
}

/**
 * 期限长度的中文描述（报告与标签用）。
 * @param period - 期限长度。
 * @returns 如 `2个月`。
 */
export function describePeriod(period: Period): string {
  const unit = period.unit === "day" ? "日" : period.unit === "month" ? "个月" : "年";
  return `${String(period.count)}${unit}`;
}
