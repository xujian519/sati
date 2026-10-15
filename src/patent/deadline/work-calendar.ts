/**
 * src/patent/deadline/work-calendar — 期限届满日的休假日顺延（专利法实施细则第 5 条末句）。
 *
 * 原文：「期限届满日是法定休假日的，以休假日后的第一个工作日为期限届满日。」
 * 《专利审查指南》第五部分第七章第 2.3 节把「移用周休息日」（调休上班）一并纳入，故本模块
 * 同时认「放假」与「调休上班」两类日期。
 *
 * 某一天是不是休假日，取决于国务院办公厅对该年度的节假日安排——它是**随年发布的资产**，
 * 不是常量。因此：
 *
 * 1. 未覆盖年份 **fail-loud**（`WorkCalendarCoverageError`），绝不按「不是休假日」处理：
 *    否则会给出一个法律上错误的届满日，而调用方看不出任何异常。
 * 2. 提供 **降级口径** `rollForwardWeekendOnly`——只用周末规则（不依赖年度数据），供
 *    `requiresFullCalendar: false` 的**参考性期限**（如专利权期限届满日）使用，并在报告里
 *    标明该日期是下界而非判决值。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  addCalendarDays,
  CalendarDateError,
  compareCalendarDates,
  formatCalendarDate,
  parseCalendarDate,
  weekday,
  type CalendarDate,
} from "./calendar.js";

/** 节假日资产文件名。 */
export const CALENDAR_FILE_NAME = "cn-holidays.yaml";

/** 随包资产路径（`dist/assets/patent/work-calendar/`；源码运行时为 `<repo>/assets/...`）。 */
const PACKAGED_CALENDAR_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../assets/patent/work-calendar",
  CALENDAR_FILE_NAME,
);

/** 工作日历无法读取、解析或内容非法时抛出。 */
export class WorkCalendarError extends Error {
  /**
   * @param message - 日历哪里不对。
   */
  constructor(message: string) {
    super(message);
    this.name = "WorkCalendarError";
  }
}

/** 日历无法回答某个日期：该日期的年份没有已装载的节假日安排。 */
export class WorkCalendarCoverageError extends WorkCalendarError {
  /** 没有节假日安排的年份。 */
  readonly year: number;

  /**
   * @param year - 没有节假日安排的年份。
   */
  constructor(year: number) {
    super(
      `工作日历未覆盖 ${String(year)} 年：无法判断该日期是否为法定休假日，故不能断定期限届满日` +
        `是否需要顺延。请补该年度节假日安排（assets/patent/work-calendar/${CALENDAR_FILE_NAME}）` +
        `，或改用降级口径（仅按周末顺延，并在报告中标明为下界）。`,
    );
    this.name = "WorkCalendarCoverageError";
    this.year = year;
  }
}

/** 一个年度的节假日安排。 */
export type WorkCalendarYear = {
  year: number;
  /** 该安排抄录自哪份文件（应含国务院办公厅通知文号）。 */
  source: string;
  /** 官方通知的 URL（可选，便于复核）。 */
  sourceUrl?: string;
  /**
   * 该安排**逐条对照官方通知**核验通过的日期（`YYYY-MM-DD`）。
   *
   * 必填且校验：一条抄错的节假日等于给出一批错误的届满日，而使用者看不出来；把「谁在什么时候
   * 核过」写进资产，是这件事唯一能被复核的痕迹。
   */
  verifiedOn: string;
  /** 放假日（非工作日），`YYYY-MM-DD`。 */
  holidays: ReadonlySet<string>;
  /** 调休上班日（原本是周休息日但上班），`YYYY-MM-DD`。 */
  workdays: ReadonlySet<string>;
};

/** 顺延结果。 */
export type RollForwardResult = {
  /** 顺延后的日期（未发生时等于入参）。 */
  date: CalendarDate;
  /** 是否发生了移动。 */
  rolled: boolean;
};

/** 已装载、可按日期查询的节假日安排。 */
export class WorkCalendar {
  private readonly years: ReadonlyMap<number, WorkCalendarYear>;

  /**
   * @param years - 各年度安排；同一年度后出现者覆盖先出现者。
   */
  constructor(years: readonly WorkCalendarYear[]) {
    this.years = new Map(years.map(entry => [entry.year, entry]));
  }

  /** 已有安排的年份，升序。 */
  get coveredYears(): number[] {
    return [...this.years.keys()].sort((left, right) => left - right);
  }

  /**
   * 该日期的年份是否已有安排。
   * @param date - 待测日期。
   * @returns 已装载则为 true。
   */
  covers(date: CalendarDate): boolean {
    return this.years.has(date.year);
  }

  /**
   * 该日是否为休息日（法定休假日，或未被调休为工作日的周六周日）。
   * @param date - 待测日期。
   * @returns 不是工作日则为 true。
   * @throws WorkCalendarCoverageError 当该日期的年份未装载。
   */
  isRestDay(date: CalendarDate): boolean {
    const year = this.years.get(date.year);
    if (year === undefined) throw new WorkCalendarCoverageError(date.year);
    const key = formatCalendarDate(date);
    if (year.holidays.has(key)) return true;
    const dayOfWeek = weekday(date);
    if (dayOfWeek !== 0 && dayOfWeek !== 6) return false;
    return !year.workdays.has(key);
  }

  /**
   * 顺延到该日当日或之后的第一个工作日（细则第 5 条）。
   *
   * 相邻年份未覆盖是**错误**而不是假设，这样 12 月的届满日不会静默滚进一个未知的 1 月。
   * @param date - 未顺延的届满日。
   * @returns 顺延后的日期与是否移动。
   * @throws WorkCalendarCoverageError 当候选日中任一日期的年份未装载。
   */
  rollForward(date: CalendarDate): RollForwardResult {
    return this.#rollForward(date, candidate => this.isRestDay(candidate));
  }

  /**
   * 降级口径：**只按周末**顺延，不使用法定节假日安排（Sati 新增）。
   *
   * 用于 `requiresFullCalendar: false` 的参考性期限（如专利权期限届满日）：这类日期的
   * 「要办的事」不是在那天，年度安排缺失不应把它整条降级为 `pending`。代价是可能少顺延
   * 若干天，故结果必须当作**下界**呈现，调用方不得把它当作判决值。
   * @param date - 未顺延的届满日。
   * @returns 顺延后的日期与是否移动。
   */
  rollForwardWeekendOnly(date: CalendarDate): RollForwardResult {
    return this.#rollForward(date, candidate => {
      const dayOfWeek = weekday(candidate);
      return dayOfWeek === 0 || dayOfWeek === 6;
    });
  }

  /** 顺延的公共循环：按 `isRest` 判定，最多试 366 天。 */
  #rollForward(date: CalendarDate, isRest: (candidate: CalendarDate) => boolean): RollForwardResult {
    let candidate = date;
    // 一年最多 366 天；该上界同时防止「全年都是休息日」的畸形日历把循环卡死。
    for (let step = 0; step <= 366; step++) {
      if (!isRest(candidate)) {
        return { date: candidate, rolled: compareCalendarDates(candidate, date) !== 0 };
      }
      candidate = addCalendarDays(candidate, 1);
    }
    throw new WorkCalendarError(
      `工作日历异常：自 ${formatCalendarDate(date)} 起连续 366 天均为非工作日，无法确定顺延后的届满日。`,
    );
  }
}

/**
 * 从 YAML 文本解析节假日资产，逐字段校验。
 *
 * 这是**文件边界**：畸形或自相矛盾的资产必须让装载失败，而不是降级成「没有节假日」——
 * 后者会让每个届满日都少顺延，且看不出来。
 * @param text - YAML 资产文本。
 * @returns 解析出的日历。
 * @throws WorkCalendarError 当资产畸形。
 */
export function parseWorkCalendar(text: string): WorkCalendar {
  const document: unknown = parseYaml(text);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new WorkCalendarError("工作日历资产必须是对象，且含 years 数组。");
  }
  const { years } = document as { years?: unknown };
  if (!Array.isArray(years) || years.length === 0) {
    throw new WorkCalendarError("工作日历资产的 years 必须为非空数组。");
  }
  const parsed = years.map((entry, index) => parseWorkCalendarYear(entry, index));
  const seen = new Set<number>();
  for (const entry of parsed) {
    if (seen.has(entry.year)) throw new WorkCalendarError(`工作日历重复声明 ${String(entry.year)} 年。`);
    seen.add(entry.year);
  }
  return new WorkCalendar(parsed);
}

/** 校验资产中的一个年度条目。 */
function parseWorkCalendarYear(entry: unknown, index: number): WorkCalendarYear {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new WorkCalendarError(`工作日历 years[${String(index)}] 必须是对象。`);
  }
  const { year, source, sourceUrl, verifiedOn, holidays, workdays } = entry as Record<string, unknown>;
  if (!Number.isInteger(year) || typeof year !== "number") {
    throw new WorkCalendarError(`工作日历 years[${String(index)}].year 必须是整数年份。`);
  }
  if (typeof source !== "string" || source.trim() === "") {
    throw new WorkCalendarError(`工作日历 years[${String(index)}].source 必须写明节假日安排的出处（含文号）。`);
  }
  if (typeof verifiedOn !== "string") {
    throw new WorkCalendarError(
      `工作日历 years[${String(index)}].verifiedOn 必须写明核验日期（YYYY-MM-DD）：` +
        "缺少它就无法判断该年数据是照官方通知核过的还是抄来的。",
    );
  }
  parseAssetDate(verifiedOn, `years[${String(index)}].verifiedOn`);
  return {
    year,
    source,
    ...(typeof sourceUrl === "string" && sourceUrl.trim() !== "" ? { sourceUrl } : {}),
    verifiedOn,
    holidays: parseDateSet(holidays, year, `years[${String(index)}].holidays`),
    workdays: parseDateSet(workdays, year, `years[${String(index)}].workdays`),
  };
}

/** 解析资产里的日期串。 */
function parseAssetDate(text: string, label: string): CalendarDate {
  try {
    return parseCalendarDate(text);
  } catch (error) {
    // 资产是**文件边界**：错误类型必须归一到 WorkCalendarError，否则调用方按类型分流时会漏掉
    // 这一支（它会以为「日历没问题」，而实际是资产里的日期写错了）。
    if (error instanceof CalendarDateError) {
      throw new WorkCalendarError(`工作日历 ${label} 含无效日期 ${JSON.stringify(text)}：${error.message}`);
    }
    throw error;
  }
}

/** 解析并校验属于某一年度的日期列表。 */
function parseDateSet(value: unknown, year: number, label: string): ReadonlySet<string> {
  if (value === undefined || value === null) return new Set<string>();
  if (!Array.isArray(value)) throw new WorkCalendarError(`工作日历 ${label} 必须是日期数组。`);
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new WorkCalendarError(`工作日历 ${label} 含非字符串日期。`);
    const date = parseAssetDate(item, label);
    if (date.year !== year) {
      throw new WorkCalendarError(`工作日历 ${label} 的 ${item} 不属于声明年份 ${String(year)}。`);
    }
    keys.add(formatCalendarDate(date));
  }
  return keys;
}

/** 已装载日历的进程内缓存（按资产路径）。 */
const calendarCache = new Map<string, WorkCalendar>();

/**
 * 装载节假日资产。
 * @param assetPath - 可选的资产路径覆盖；默认随包资产。
 * @returns 装载出的日历。
 * @throws WorkCalendarError 当资产缺失或非法。
 */
export function loadWorkCalendar(assetPath: string = PACKAGED_CALENDAR_PATH): WorkCalendar {
  const cached = calendarCache.get(assetPath);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = readFileSync(assetPath, "utf8");
  } catch (error) {
    // 只有「资产读不到」会走到这里；错误里带上路径，便于定位是没构建还是没拷贝。
    if (error instanceof Error) {
      throw new WorkCalendarError(`无法读取工作日历资产 ${assetPath}: ${error.message}`);
    }
    throw error;
  }
  const calendar = parseWorkCalendar(text);
  calendarCache.set(assetPath, calendar);
  return calendar;
}

/** 清空装载缓存（测试用；也用于资产热更新后强制重读）。 */
export function clearWorkCalendarCache(): void {
  calendarCache.clear();
}

/**
 * 次日安排应已发布的判据（**Sati 新增**）。
 *
 * 国务院办公厅惯例于每年 11 月发布次年安排（实测：2025 年安排 2024-11-12 发布，2026 年安排
 * 2025-11-04 发布），故取当年 12 月 1 日为界：到此日仍无次年数据即视为**维护缺口**。
 */
export type CalendarFreshnessPolicy = {
  /** 次年起须已覆盖的月（默认 12）。 */
  nextYearRequireMonth: number;
  /** 次年起须已覆盖的日（默认 1）。 */
  nextYearRequireDay: number;
};

/** 默认维护窗口：当年 12 月 1 日起必须有次年安排。 */
export const DEFAULT_FRESHNESS_POLICY: CalendarFreshnessPolicy = {
  nextYearRequireMonth: 12,
  nextYearRequireDay: 1,
};

/**
 * 资产新鲜度门禁（**Sati 新增**）。
 *
 * 这是「降级但不静默」在**资产层**的落点：日历不覆盖某年时，运行时只会把相关期限降级为
 * `pending` 或下界，**不会**让任何人看出「资产该更新了」。故把这件事变成一个会红的门禁。
 *
 * 两段判据：
 * 1. **当年必须已覆盖**——否则该年所有需要顺延的期限都失去了判决值；
 * 2. **次年**在 {@link CalendarFreshnessPolicy} 的界限日之后必须已覆盖——给发布留出窗口，
 *    但窗口一过就红；
 *
 * 为什么不是「当年 + 次年都必须覆盖」：次年安排在**发布前客观不存在**（实测 2026-10-15 时
 * 2027 年安排尚未发布），要求它会让门禁在每年 11 月之前恒红，从而被当成噪音忽略。
 * @param calendar - 已装载的日历。
 * @param today - 判定基准日（由调用方给出，不读宿主时钟，保证可测）。
 * @param policy - 维护窗口策略。
 * @throws WorkCalendarError 当当年未覆盖，或过了窗口次年仍未覆盖。
 */
export function assertCalendarFreshness(
  calendar: WorkCalendar,
  today: CalendarDate,
  policy: CalendarFreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): void {
  const covered = new Set(calendar.coveredYears);
  if (!covered.has(today.year)) {
    throw new WorkCalendarError(
      `工作日历未覆盖当年 ${String(today.year)}（已覆盖：${calendar.coveredYears.join("、")}）。` +
        `该年所有需顺延的期限都会失去判决值，请立即补该年度安排。`,
    );
  }
  const next = today.year + 1;
  if (covered.has(next)) return;
  const requireFrom: CalendarDate = {
    year: today.year,
    month: policy.nextYearRequireMonth,
    day: policy.nextYearRequireDay,
  };
  if (compareCalendarDates(today, requireFrom) >= 0) {
    throw new WorkCalendarError(
      `工作日历未覆盖次年 ${String(next)}，且今日（${formatCalendarDate(today)}）已过 ` +
        `${formatCalendarDate(requireFrom)}：按惯例（国办每年 11 月发布次年安排）该安排应已发布。` +
        `在此之前的届满日会失去判决值或只给出下界，请补录 ${String(next)} 年安排（附通知文号）。`,
    );
  }
}
