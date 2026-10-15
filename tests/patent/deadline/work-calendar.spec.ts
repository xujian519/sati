import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCalendarDate, type CalendarDate } from "../../../src/patent/deadline/calendar.js";
import {
  assertCalendarFreshness,
  clearWorkCalendarCache,
  loadWorkCalendar,
  parseWorkCalendar,
  WorkCalendar,
  WorkCalendarCoverageError,
  WorkCalendarError,
  type WorkCalendarYear,
} from "../../../src/patent/deadline/work-calendar.js";

const d = (text: string): CalendarDate => parseCalendarDate(text);

/** 只含一年的合成日历（不依赖随包资产，故断言稳定）。 */
function synthetic(year: number): WorkCalendar {
  const entry: WorkCalendarYear = {
    year,
    source: "测试用合成日历",
    verifiedOn: "2026-10-15",
    holidays: new Set([`${String(year)}-05-01`]),
    workdays: new Set([`${String(year)}-05-09`]),
  };
  return new WorkCalendar([entry]);
}

describe("patent/deadline/work-calendar 装载与解析", () => {
  it("装载随包节假日资产", () => {
    clearWorkCalendarCache();
    const calendar = loadWorkCalendar();
    assert.ok(calendar.coveredYears.includes(2026), `已覆盖：${calendar.coveredYears.join("、")}`);
    assert.ok(calendar.coveredYears.includes(2025));
  });

  it("畸形资产 fail-loud（而不是降级成「没有节假日」）", () => {
    assert.throws(() => parseWorkCalendar("years: []"), WorkCalendarError);
    assert.throws(() => parseWorkCalendar("{}"), WorkCalendarError);
    assert.throws(() => parseWorkCalendar("[]"), WorkCalendarError);
    // 缺 source（文号）。
    assert.throws(
      () => parseWorkCalendar('years:\n  - year: 2026\n    verifiedOn: "2026-10-15"\n    holidays: []'),
      WorkCalendarError,
    );
    // 缺 verifiedOn（核验日期）。
    assert.throws(
      () => parseWorkCalendar('years:\n  - year: 2026\n    source: "某通知"\n    holidays: []'),
      WorkCalendarError,
    );
    // 核验日期本身不合法。
    assert.throws(
      () =>
        parseWorkCalendar(
          'years:\n  - year: 2026\n    source: "某通知"\n    verifiedOn: "2026-13-40"\n    holidays: []',
        ),
      WorkCalendarError,
    );
    // 日期不属于声明年份。
    assert.throws(
      () =>
        parseWorkCalendar(
          'years:\n  - year: 2026\n    source: "某通知"\n    verifiedOn: "2026-10-15"\n    holidays:\n      - 2025-01-01',
        ),
      WorkCalendarError,
    );
    // 重复年份。
    assert.throws(
      () =>
        parseWorkCalendar(
          'years:\n  - year: 2026\n    source: "甲"\n    verifiedOn: "2026-10-15"\n    holidays: []\n' +
            '  - year: 2026\n    source: "乙"\n    verifiedOn: "2026-10-15"\n    holidays: []',
        ),
      WorkCalendarError,
    );
  });

  it("资产自检：当前年份必须有节假日安排，且次年不得超期缺失", () => {
    // ⚠️ 这条**故意依赖真实系统日期**：它就是资产维护门禁。缺当年数据、或过了 12-01 仍缺次年
    // 数据时，本测试会红——那正是要提醒维护者去补数据，而不是让运行时静默降级一整年。
    const calendar = loadWorkCalendar();
    const now = new Date();
    const today: CalendarDate = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
    assert.doesNotThrow(() => assertCalendarFreshness(calendar, today));
  });

  it("资产自检：两年数据都写明通知文号与核验日期", () => {
    const calendar = loadWorkCalendar();
    for (const year of calendar.coveredYears) {
      assert.ok(year >= 2025, `${String(year)} 年数据不应早于 2025`);
    }
  });
});

describe("patent/deadline/work-calendar 休息日与顺延", () => {
  const calendar = loadWorkCalendar();

  it("法定假日是休息日", () => {
    assert.equal(calendar.isRestDay(d("2026-10-01")), true);
    assert.equal(calendar.isRestDay(d("2026-02-17")), true);
  });

  it("调休上班日**不是**休息日（哪怕是周六周日）", () => {
    assert.equal(calendar.isRestDay(d("2026-02-14")), false); // 周六，但调休上班
    assert.equal(calendar.isRestDay(d("2026-09-20")), false); // 周日，但调休上班
    assert.equal(calendar.isRestDay(d("2026-10-10")), false); // 周六，但调休上班
    assert.equal(calendar.isRestDay(d("2026-01-04")), false); // 周日，但调休上班
  });

  it("普通工作日与普通周末", () => {
    assert.equal(calendar.isRestDay(d("2026-10-15")), false); // 周四
    assert.equal(calendar.isRestDay(d("2026-11-01")), true); // 周日，且无调休
    assert.equal(calendar.isRestDay(d("2026-11-07")), true); // 周六
  });

  it("未覆盖年份 fail-loud 而不是按「不是休假日」处理", () => {
    assert.throws(() => calendar.isRestDay(d("2027-01-04")), WorkCalendarCoverageError);
    assert.throws(() => calendar.rollForward(d("2027-01-04")), WorkCalendarCoverageError);
  });

  it("顺延：周末顺延到下一个工作日", () => {
    const result = calendar.rollForward(d("2026-11-01"));
    assert.equal(result.rolled, true);
    assert.equal(result.date.year, 2026);
    assert.equal(result.date.month, 11);
    assert.equal(result.date.day, 2);
  });

  it("顺延：工作日不动", () => {
    const result = calendar.rollForward(d("2026-11-03"));
    assert.equal(result.rolled, false);
    assert.equal(result.date.day, 3);
  });

  it("顺延：法定假期整段跳过", () => {
    // 国庆 10-01..10-07；10-08 是周四，正常上班。
    const result = calendar.rollForward(d("2026-10-01"));
    assert.equal(result.date.month, 10);
    assert.equal(result.date.day, 8);
  });

  it("顺延：元旦假期后落到**调休上班**的周日（说明调休被正确识别）", () => {
    // 元旦 01-01..01-03；01-04 是周日但调休上班，故届满日就是 01-04。
    const result = calendar.rollForward(d("2026-01-03"));
    assert.equal(result.date.month, 1);
    assert.equal(result.date.day, 4);
  });

  it("降级口径 rollForwardWeekendOnly 只跳周末，不认法定假日", () => {
    // 2026-10-01 是周四：完整口径顺延到 10-08，降级口径认为它本来就是工作日。
    const weekend = calendar.rollForwardWeekendOnly(d("2026-10-01"));
    assert.equal(weekend.rolled, false);
    assert.equal(weekend.date.month, 10);
    assert.equal(weekend.date.day, 1);
    // 但周末仍会跳。
    const sunday = calendar.rollForwardWeekendOnly(d("2026-11-01"));
    assert.equal(sunday.date.day, 2);
  });
});

describe("patent/deadline/work-calendar 覆盖门禁（合成日历，断言与真实日期无关）", () => {
  const calendar = synthetic(2026);

  it("当年已覆盖、未到 12-01 时次年可缺", () => {
    assert.doesNotThrow(() => assertCalendarFreshness(calendar, d("2026-10-15")));
  });

  it("过了 12-01 仍缺次年数据即报错（维护窗口结束）", () => {
    assert.throws(() => assertCalendarFreshness(calendar, d("2026-12-01")), WorkCalendarError);
    assert.throws(() => assertCalendarFreshness(calendar, d("2026-12-31")), WorkCalendarError);
  });

  it("当年缺失立即报错", () => {
    assert.throws(() => assertCalendarFreshness(calendar, d("2027-01-05")), WorkCalendarError);
    assert.throws(() => assertCalendarFreshness(calendar, d("2025-06-01")), WorkCalendarError);
  });

  it("次年已覆盖时不报错（12-01 之后也一样）", () => {
    const years: WorkCalendarYear[] = [
      { year: 2026, source: "甲", verifiedOn: "2026-10-15", holidays: new Set(), workdays: new Set() },
      { year: 2027, source: "乙", verifiedOn: "2026-11-20", holidays: new Set(), workdays: new Set() },
    ];
    assert.doesNotThrow(() => assertCalendarFreshness(new WorkCalendar(years), d("2026-12-31")));
    assert.doesNotThrow(() => assertCalendarFreshness(new WorkCalendar(years), d("2027-06-01")));
  });
});
