import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
} from "../../../src/patent/deadline/calendar.js";
import { describePeriod, PeriodError, periodEnd } from "../../../src/patent/deadline/period.js";

describe("patent/deadline/calendar", () => {
  it("解析并格式化 YYYY-MM-DD（允许不补零）", () => {
    assert.deepEqual(parseCalendarDate("2026-10-15"), { year: 2026, month: 10, day: 15 });
    assert.deepEqual(parseCalendarDate("2026-1-5"), { year: 2026, month: 1, day: 5 });
    assert.equal(formatCalendarDate({ year: 2026, month: 1, day: 5 }), "2026-01-05");
  });

  it("拒绝不存在的日期：非闰年 2-29、13 月、0 日", () => {
    assert.throws(() => parseCalendarDate("2025-02-29"), CalendarDateError);
    assert.throws(() => parseCalendarDate("2024-02-30"), CalendarDateError);
    assert.throws(() => parseCalendarDate("2026-13-01"), CalendarDateError);
    assert.throws(() => parseCalendarDate("2026-01-00"), CalendarDateError);
    assert.throws(() => parseCalendarDate("2026/01/05"), CalendarDateError);
    // 闰年 2-29 合法。
    assert.doesNotThrow(() => parseCalendarDate("2024-02-29"));
  });

  it("拒绝 1900 年以前的年份（Date.UTC 会把 0-99 读作 19xx）", () => {
    assert.throws(() => parseCalendarDate("0025-01-15"), CalendarDateError);
    assert.throws(() => parseCalendarDate("1899-12-31"), CalendarDateError);
    assert.doesNotThrow(() => parseCalendarDate("1900-01-01"));
  });

  it("天数与星期几", () => {
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2025, 2), 28);
    assert.equal(daysInMonth(2026, 11), 30);
    // 2026-11-01 是周日。
    assert.equal(weekday(parseCalendarDate("2026-11-01")), 0);
    assert.equal(weekday(parseCalendarDate("2026-11-02")), 1);
  });

  it("按月平移取相应日，目标月无该日时取月末（细则第 5 条）", () => {
    assert.equal(formatCalendarDate(addCalendarMonths(parseCalendarDate("1999-12-31"), 2)), "2000-02-29");
    assert.equal(formatCalendarDate(addCalendarMonths(parseCalendarDate("2026-01-31"), 1)), "2026-02-28");
    assert.equal(formatCalendarDate(addCalendarMonths(parseCalendarDate("2020-01-15"), 24)), "2022-01-15");
    // 跨年回溯。
    assert.equal(formatCalendarDate(addCalendarMonths(parseCalendarDate("2026-01-15"), -1)), "2025-12-15");
  });

  it("按日平移与天数差", () => {
    assert.equal(formatCalendarDate(addCalendarDays(parseCalendarDate("2026-12-31"), 1)), "2027-01-01");
    assert.equal(daysBetween(parseCalendarDate("2026-10-15"), parseCalendarDate("2026-11-01")), 17);
    assert.equal(daysBetween(parseCalendarDate("2026-11-01"), parseCalendarDate("2026-10-15")), -17);
  });

  it("比较日期", () => {
    assert.equal(compareCalendarDates(parseCalendarDate("2026-01-01"), parseCalendarDate("2026-01-02")), -1);
    assert.equal(compareCalendarDates(parseCalendarDate("2026-01-02"), parseCalendarDate("2026-01-02")), 0);
    assert.equal(compareCalendarDates(parseCalendarDate("2026-01-03"), parseCalendarDate("2026-01-02")), 1);
  });

  describe("assertCalendarDate（求值器入口的值级断言，Sati 新增）", () => {
    it("接受真实存在的日期", () => {
      assert.doesNotThrow(() => assertCalendarDate({ year: 2026, month: 2, day: 28 }, "filingDate"));
      assert.doesNotThrow(() => assertCalendarDate({ year: 2024, month: 2, day: 29 }, "filingDate"));
    });

    it("拒绝 NaN —— 否则会算出 NaN 届满日 + status normal 的假正常结果", () => {
      assert.throws(() => assertCalendarDate({ year: Number.NaN, month: 1, day: 1 }, "filingDate"), CalendarDateError);
      assert.throws(
        () => assertCalendarDate({ year: 2026, month: Number.NaN, day: 1 }, "filingDate"),
        CalendarDateError,
      );
    });

    it("拒绝非整数、越界与非数字类型", () => {
      assert.throws(() => assertCalendarDate({ year: 2026.5, month: 1, day: 1 }, "filingDate"), CalendarDateError);
      assert.throws(() => assertCalendarDate({ year: 2026, month: 13, day: 1 }, "filingDate"), CalendarDateError);
      assert.throws(() => assertCalendarDate({ year: 2026, month: 2, day: 30 }, "filingDate"), CalendarDateError);
      assert.throws(
        () =>
          assertCalendarDate(
            { year: "2026", month: 1, day: 1 } as unknown as { year: number; month: number; day: number },
            "filingDate",
          ),
        CalendarDateError,
      );
    });

    it("错误信息指名是哪个输入", () => {
      assert.throws(
        () => assertCalendarDate({ year: Number.NaN, month: 1, day: 1 }, "priorityDate"),
        (error: unknown) => error instanceof CalendarDateError && error.input.includes("priorityDate"),
      );
    });
  });
});

describe("patent/deadline/period", () => {
  const start = parseCalendarDate("2026-01-15");

  it("起算日不计入：N 日期限届满于 D+N（细则第 5 条）", () => {
    assert.equal(formatCalendarDate(periodEnd(start, { unit: "day", count: 15 })), "2026-01-30");
    assert.equal(formatCalendarDate(periodEnd(start, { unit: "day", count: 1 })), "2026-01-16");
  });

  it("按月/按年取相应日", () => {
    assert.equal(formatCalendarDate(periodEnd(start, { unit: "month", count: 2 })), "2026-03-15");
    assert.equal(formatCalendarDate(periodEnd(start, { unit: "year", count: 3 })), "2029-01-15");
    assert.equal(formatCalendarDate(periodEnd(start, { unit: "year", count: 20 })), "2046-01-15");
  });

  it("月末规则", () => {
    assert.equal(
      formatCalendarDate(periodEnd(parseCalendarDate("2026-01-31"), { unit: "month", count: 1 })),
      "2026-02-28",
    );
    assert.equal(
      formatCalendarDate(periodEnd(parseCalendarDate("2023-11-30"), { unit: "month", count: 3 })),
      "2024-02-29",
    );
  });

  it("非正整数的期限长度 fail-loud", () => {
    assert.throws(() => periodEnd(start, { unit: "month", count: 0 }), PeriodError);
    assert.throws(() => periodEnd(start, { unit: "month", count: -1 }), PeriodError);
    assert.throws(() => periodEnd(start, { unit: "month", count: 1.5 }), PeriodError);
  });

  it("中文期限描述", () => {
    assert.equal(describePeriod({ unit: "day", count: 15 }), "15日");
    assert.equal(describePeriod({ unit: "month", count: 2 }), "2个月");
    assert.equal(describePeriod({ unit: "year", count: 3 }), "3年");
  });
});
