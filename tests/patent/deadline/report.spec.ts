import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCalendarDate, parseCalendarDate, type CalendarDate } from "../../../src/patent/deadline/calendar.js";
import { renderDeadlineReport } from "../../../src/patent/deadline/report.js";
import { evaluateDeadlines, type DeadlineQuery, type DeadlineReport } from "../../../src/patent/deadline/statutes.js";
import { loadWorkCalendar } from "../../../src/patent/deadline/work-calendar.js";

const d = (text: string): CalendarDate => parseCalendarDate(text);
const calendar = loadWorkCalendar();

function build(query: DeadlineQuery): { report: DeadlineReport; text: string } {
  const report = evaluateDeadlines(query, { calendar, reminderLeadDays: 30 });
  return {
    report,
    text: renderDeadlineReport(report, {
      kind: query.kind,
      filingDate: formatCalendarDate(query.filingDate),
      today: formatCalendarDate(query.today),
      claimsPriority: query.claimsPriority,
    }),
  };
}

describe("patent/deadline/report", () => {
  const simpleQuery: DeadlineQuery = {
    kind: "invention",
    filingDate: d("2026-08-15"),
    claimsPriority: false,
    today: d("2026-10-15"),
  };

  it("抬头写明类型、申请日、基准日与优先权状态", () => {
    const { text } = build(simpleQuery);
    assert.match(text, /patent_deadlines: 发明专利 · 申请日 2026-08-15 · 基准日 2026-10-15 · 未主张优先权/);
  });

  it("写明顺延口径与日历覆盖年份", () => {
    const { text } = build(simpleQuery);
    assert.match(text, /已应用专利法实施细则第5条的届满日顺延/);
    assert.match(text, /工作日历已覆盖：2025、2026/);
  });

  it("omit 口径给出不同的措辞", () => {
    const { text } = build({ ...simpleQuery, restDayRule: "omit" });
    assert.match(text, /不顺延/);
  });

  it("未覆盖年份的条目呈现为「下界，非判决值」而不是一个判决日期", () => {
    const { text } = build(simpleQuery);
    assert.match(text, /（\*\*下界\*\*，非判决值）/);
  });

  it("下界段落区分「最后一天要办事」与参考性日期，并给出补数据的动作", () => {
    const { text } = build({ ...simpleQuery, filingDate: d("2020-01-15") });
    assert.match(text, /\*\*最后一天要办事\*\*/);
    assert.match(text, /参考性日期/);
    assert.match(text, /务必补齐/);
  });

  it("pending 段落保留「不以固定年数代替通知书送达日」的语义", () => {
    const { text } = build(simpleQuery);
    assert.match(text, /不以固定年数代替通知书送达日/);
    assert.match(text, /grant-notice/);
  });

  it("年费条目渲染补缴窗口", () => {
    const { text } = build({
      ...simpleQuery,
      filingDate: d("2020-01-15"),
      authorizationPublicationDate: d("2022-06-20"),
    });
    assert.match(text, /年费补缴窗口/);
    assert.match(text, /2024-01-15 起算，最迟 2024-07-15/);
  });

  it("恢复建议只给可恢复的期限；被排除的期限单独列出（细则第 6 条第 5 款）", () => {
    const { report, text } = build({ ...simpleQuery, filingDate: d("2020-01-15") });
    const overdueNotRestorable = report.computed.filter(
      entry => entry.status === "overdue" && entry.restorationExcluded !== undefined,
    );
    assert.ok(overdueNotRestorable.length > 0, "本用例应至少有一条「已逾期且不可恢复」的期限");
    assert.match(text, /不适用.*上述恢复规定/);
    assert.match(text, /专利法实施细则第6条第5款/);
  });

  it("不可恢复段在没有任何逾期项时完全不出现", () => {
    const { text } = build({ ...simpleQuery, filingDate: d("2030-08-15"), today: d("2030-09-01") });
    assert.doesNotMatch(text, /是否仍在救济期内/);
  });

  it("送达口径需复核时打出提示", () => {
    const { text } = build({
      ...simpleQuery,
      notices: [
        {
          kind: "grant-notice",
          delivery: { mode: "electronic", dispatchDate: d("2026-09-01"), enteredDate: d("2026-09-03") },
        },
      ],
    });
    assert.match(text, /起算点需复核/);
    assert.match(text, /进入日与发文日不一致/);
  });
});
