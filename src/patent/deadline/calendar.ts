/**
 * src/patent/deadline/calendar — 民事日历日期与算术（专利期限计算的基础层）。
 *
 * 全部值是「没有时区、没有时刻」的日历日期，所以期限算术不受宿主时钟与进程时区影响。
 *
 * 为什么不直接用 `Date` 做月份加减：细则第 5 条的月末规则（「该月无相应日的，以该月最后
 * 一日为期限届满日」）不是毫秒加减；且 `Date.UTC` 把 0–99 年读作 19xx，一个手误的
 * `0025-01-15` 会整世纪漂移——故在解析边界直接拒绝低年值。
 */

/** 民事日历日期；`month` 为 1–12。 */
export type CalendarDate = {
  year: number;
  /** 月，1–12。 */
  month: number;
  /** 日，1–31。 */
  day: number;
};

const DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * 可接受的**最低年份**。
 *
 * 四位数字形式允许前导零，而 `Date.UTC` 把 0–99 读作 19xx：手误的 `0025-01-15` 会在
 * 天数算术里整体漂到另一个世纪，而月份算术仍保留原年份。与其产出矛盾结果，不如在
 * 解析边界拒绝。
 */
const MIN_DATE_YEAR = 1900;

/** 日期字符串不是真实存在的 `YYYY-MM-DD` 民事日期时抛出。 */
export class CalendarDateError extends Error {
  /** 被拒绝的输入。 */
  readonly input: string;

  /**
   * @param input - 被拒绝的日期（字符串或已字符串化的值）。
   */
  constructor(input: string) {
    super(`不是有效的日期（需要 YYYY-MM-DD 且为真实存在的日期）: ${JSON.stringify(input)}`);
    this.name = "CalendarDateError";
    this.input = input;
  }
}

/**
 * 某年某月的天数（公历）。
 * @param year - 四位年份。
 * @param month - 月，1–12。
 * @returns 该月天数。
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 解析 `YYYY-MM-DD`（允许月/日不补零）。
 *
 * 拒绝不存在的月与当月没有的日（如 `2025-02-29`）——手误的申请日绝不能静默变成另一天。
 * @param text - 日期字符串。
 * @returns 解析出的日期。
 * @throws CalendarDateError 当字符串不是真实存在的日期。
 */
export function parseCalendarDate(text: string): CalendarDate {
  const match = DATE_PATTERN.exec(text.trim());
  if (match === null) throw new CalendarDateError(text);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_DATE_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CalendarDateError(text);
  }
  return { year, month, day };
}

/**
 * 求值器入口的日期值校验（**Sati 新增**）。
 *
 * dsh 的日期校验只在 `parseCalendarDate` 里对**字符串**生效，求值器本身不校验：绕过解析器
 * 直接构造 `{ year: NaN, month: 1, day: 1 }` 的 query，会得到 NaN 的届满日与
 * `status: "normal"`——一个「看起来正常」的结果。核验层最怕的正是这种静默，故在求值器入口
 * 对**已经构造好的值**再断言一次。
 * @param date - 待校验的日期值。
 * @param label - 出错时指名是哪个输入（如 `filingDate`）。
 * @throws CalendarDateError 当值不是真实存在的日期。
 */
export function assertCalendarDate(date: CalendarDate, label: string): void {
  const { year, month, day } = date as { year?: unknown; month?: unknown; day?: unknown };
  const ok =
    typeof year === "number" &&
    Number.isInteger(year) &&
    year >= MIN_DATE_YEAR &&
    typeof month === "number" &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    typeof day === "number" &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= daysInMonth(year, month);
  if (!ok) throw new CalendarDateError(`${label}=${JSON.stringify(date)}`);
}

/**
 * 格式化为 `YYYY-MM-DD`。
 * @param date - 日期。
 * @returns ISO 风格日期串。
 */
export function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${String(date.year).padStart(4, "0")}-${month}-${day}`;
}

/** 日期的 UTC 毫秒（仅用于排序与天数差）。 */
function utcMillis(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

/**
 * 比较两个日期。
 * @param left - 左日期。
 * @param right - 右日期。
 * @returns 左早于右为 -1，相等为 0，晚于为 1。
 */
export function compareCalendarDates(left: CalendarDate, right: CalendarDate): -1 | 0 | 1 {
  const delta = utcMillis(left) - utcMillis(right);
  if (delta < 0) return -1;
  return delta > 0 ? 1 : 0;
}

/**
 * 星期几。
 * @param date - 日期。
 * @returns 0 = 周日 … 6 = 周六。
 */
export function weekday(date: CalendarDate): number {
  return new Date(utcMillis(date)).getUTCDay();
}

/**
 * 按整天平移日期。
 * @param date - 起始日期。
 * @param days - 天数（负数为回溯）。
 * @returns 平移后的日期。
 */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(utcMillis(date) + days * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * 按月平移日期：取目标月的相应日，目标月没有该日时取该月最后一日（细则第 5 条）。
 *
 * `1999-12-31` 加两个月是 `2000-02-29`，不是 `2000-03-02`。
 * @param date - 起始日期。
 * @param months - 月数（负数为回溯）。
 * @returns 平移后的日期。
 */
export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/**
 * 两个日期之间的整日数（忽略时刻）。
 * @param from - 较早日期。
 * @param to - 较晚日期。
 * @returns 带符号天数（`to - from`）。
 */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((utcMillis(to) - utcMillis(from)) / 86_400_000);
}
