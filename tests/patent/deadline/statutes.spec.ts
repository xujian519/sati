import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalendarDateError, parseCalendarDate, type CalendarDate } from "../../../src/patent/deadline/calendar.js";
import {
  DeadlineQueryError,
  describePatentKind,
  evaluateDeadlines,
  type ComputedDeadline,
  type DeadlineQuery,
  type DeadlineReport,
  type PendingDeadline,
} from "../../../src/patent/deadline/statutes.js";
import { loadWorkCalendar } from "../../../src/patent/deadline/work-calendar.js";

const d = (text: string): CalendarDate => parseCalendarDate(text);
const TODAY = d("2026-10-15");
const calendar = loadWorkCalendar();

function evaluate(query: DeadlineQuery): DeadlineReport {
  return evaluateDeadlines(query, { calendar, reminderLeadDays: 30 });
}

function base(over: Partial<DeadlineQuery> = {}): DeadlineQuery {
  return { kind: "invention", filingDate: d("2026-08-15"), claimsPriority: false, today: TODAY, ...over };
}

function computed(report: DeadlineReport, id: string): ComputedDeadline {
  const found = report.computed.find(entry => entry.id === id);
  assert.ok(found !== undefined, `未找到 computed 条目 ${id}；实际有：${report.computed.map(e => e.id).join("、")}`);
  return found;
}

function pending(report: DeadlineReport, id: string): PendingDeadline {
  const found = report.pending.find(entry => entry.id === id);
  assert.ok(found !== undefined, `未找到 pending 条目 ${id}；实际有：${report.pending.map(e => e.id).join("、")}`);
  return found;
}

describe("patent/deadline/statutes 输入校验", () => {
  it("主张优先权但无优先权日 → fail-loud", () => {
    assert.throws(() => evaluate(base({ claimsPriority: true })), DeadlineQueryError);
  });

  it("有优先权日但声明不主张 → 反方向同样 fail-loud", () => {
    assert.throws(() => evaluate(base({ claimsPriority: false, priorityDate: d("2026-03-01") })), DeadlineQueryError);
  });

  it("坏类型日期在求值器入口 fail-loud（dsh 此处静默产出 NaN 日期 + status normal）", () => {
    assert.throws(() => evaluate(base({ filingDate: { year: Number.NaN, month: 1, day: 1 } })), CalendarDateError);
    assert.throws(() => evaluate(base({ today: { year: 2026, month: 13, day: 1 } })), CalendarDateError);
  });

  it("一次性通知类型重复记录 → fail-loud（静默取一份会掩盖另一份）", () => {
    assert.throws(
      () =>
        evaluate(
          base({
            notices: [
              { kind: "grant-notice", delivery: { dispatchDate: d("2026-09-01") } },
              { kind: "grant-notice", delivery: { dispatchDate: d("2026-10-01") } },
            ],
          }),
        ),
      DeadlineQueryError,
    );
  });
});

describe("patent/deadline/statutes 以通知送达起算的期限", () => {
  it("未给授权通知时办登与分案为 pending，并指名缺哪个输入", () => {
    const report = evaluate(base());
    const registration = pending(report, "registration");
    assert.match(registration.requiredInput, /grant-notice/);
    // 计划要求保留的语义：不以申请日起算的固定年数替代。
    assert.match(registration.reason, /不以申请日起算的固定年数替代/);
    assert.match(pending(report, "divisional-application").requiredInput, /grant-notice/);
  });

  it("电子送达 2026-09-01 起算 2 个月：本体届满日 2026-11-01（周日），顺延至 2026-11-02", () => {
    const report = evaluate(
      base({
        kind: "utility-model",
        notices: [{ kind: "grant-notice", delivery: { mode: "electronic", dispatchDate: d("2026-09-01") } }],
      }),
    );
    const registration = computed(report, "registration");
    assert.equal(registration.rawDueDate, "2026-11-01");
    assert.equal(registration.dueDate, "2026-11-02");
    assert.equal(registration.rolledForward, true);
    // 分案与办登同期届满，两条都要出，不合并。
    const divisional = computed(report, "divisional-application");
    assert.equal(divisional.rawDueDate, "2026-11-01");
    assert.equal(divisional.dueDate, "2026-11-02");
  });

  it("送达方式进 triggerBasis，供报告追溯", () => {
    const report = evaluate(
      base({
        notices: [{ kind: "grant-notice", delivery: { mode: "electronic", dispatchDate: d("2026-09-01") } }],
      }),
    );
    assert.match(computed(report, "registration").triggerBasis ?? "", /电子形式送达/);
  });

  it("可重复类型（后续审查意见）为每一份通知各出一行", () => {
    const report = evaluate(
      base({
        notices: [
          { kind: "office-action-subsequent", delivery: { dispatchDate: d("2026-09-10") } },
          { kind: "office-action-subsequent", delivery: { dispatchDate: d("2026-10-01") } },
        ],
      }),
    );
    const first = computed(report, "oa-response-subsequent");
    const second = computed(report, "oa-response-subsequent-2");
    assert.equal(first.rawDueDate, "2026-11-10");
    assert.equal(second.rawDueDate, "2026-12-01");
    assert.match(second.label, /第 2 份通知/);
  });

  it("答复期限默认长度：一通 4 个月、后续 2 个月", () => {
    const report = evaluate(
      base({
        notices: [{ kind: "office-action-first", delivery: { dispatchDate: d("2026-09-10") } }],
      }),
    );
    assert.equal(computed(report, "oa-response-first").rawDueDate, "2027-01-10");
  });

  it("通知书指定期限覆盖默认长度", () => {
    const report = evaluate(
      base({
        notices: [{ kind: "office-action-first", delivery: { dispatchDate: d("2026-09-10") }, designatedMonths: 2 }],
      }),
    );
    assert.equal(computed(report, "oa-response-first").rawDueDate, "2026-11-10");
    assert.match(computed(report, "oa-response-first").triggerBasis ?? "", /指定期限 2 个月/);
  });
});

describe("patent/deadline/statutes 双口径申请费（细则第 112 条）", () => {
  it("口径一自申请日起 2 个月，总是可算", () => {
    const report = evaluate(base({ filingDate: d("2026-08-15") }));
    assert.equal(computed(report, "application-fee-from-filing").rawDueDate, "2026-10-15");
  });

  it("口径二自收到受理通知书起 15 日，未记录该通知时为 pending 而不影响口径一", () => {
    const report = evaluate(base({ filingDate: d("2026-08-15") }));
    const noticeFee = pending(report, "application-fee-from-notice");
    assert.match(noticeFee.requiredInput, /acceptance-notice/);
    assert.match(noticeFee.reason, /口径一.*不受影响/);
    // 口径一仍然在。
    assert.equal(computed(report, "application-fee-from-filing").rawDueDate, "2026-10-15");
  });

  it("两个口径同时给出，且可以一个已届满、一个仍在跑（本测试的核心主张）", () => {
    const report = evaluate(
      base({
        filingDate: d("2026-08-15"),
        notices: [{ kind: "acceptance-notice", delivery: { dispatchDate: d("2026-09-25") } }],
      }),
    );
    const fromFiling = computed(report, "application-fee-from-filing");
    const fromNotice = computed(report, "application-fee-from-notice");
    assert.equal(fromFiling.rawDueDate, "2026-10-15");
    assert.equal(fromNotice.rawDueDate, "2026-10-10");
    // 一个 10-15（今天）、一个 10-10（已过 5 天）：只报一个口径必然误判。
    assert.equal(fromFiling.status, "urgent");
    assert.equal(fromNotice.status, "overdue");
  });
});

describe("patent/deadline/statutes 顺延口径", () => {
  const query = (rule: "apply" | "omit"): DeadlineQuery =>
    base({
      kind: "utility-model",
      restDayRule: rule,
      notices: [{ kind: "grant-notice", delivery: { mode: "electronic", dispatchDate: d("2026-09-01") } }],
    });

  it("apply 与 omit 的 dueDate 不同，rawDueDate 相同", () => {
    const applied = computed(evaluate(query("apply")), "registration");
    const omitted = computed(evaluate(query("omit")), "registration");
    assert.equal(applied.rawDueDate, "2026-11-01");
    assert.equal(omitted.rawDueDate, "2026-11-01");
    assert.equal(applied.dueDate, "2026-11-02");
    assert.equal(omitted.dueDate, "2026-11-01");
    assert.equal(applied.rolledForward, true);
    assert.equal(omitted.rolledForward, false);
  });

  it("报告记录所用的口径", () => {
    assert.equal(evaluate(query("omit")).restDayRule, "omit");
    assert.equal(evaluate(query("apply")).restDayRule, "apply");
  });
});

describe("patent/deadline/statutes 日历未覆盖年份 → 下界而非消失", () => {
  it("参考性期限（专利权期限）给 rawDueDate + 下界，且**不给** dueDate", () => {
    const report = evaluate(base({ filingDate: d("2020-01-15") }));
    const term = computed(report, "patent-term");
    assert.equal(term.requiresFullCalendar, false);
    assert.equal(term.rawDueDate, "2040-01-15");
    assert.equal(term.dueDate, undefined);
    assert.equal(term.rollForward, "weekend-only");
    // 2040-01-15 是周日 → 仅按周末的下界为 2040-01-16。
    assert.equal(term.dueDateLowerBound, "2040-01-16");
    assert.equal(term.daysRemainingBasis, "lowerBound");
    assert.ok(term.calendarCaveat?.includes("2040"));
  });

  it("要办事的期限同样给下界（不是 pending），但保留 requiresFullCalendar=true", () => {
    const report = evaluate(base({ filingDate: d("2027-06-15") }));
    const fee = computed(report, "application-fee-from-filing");
    assert.equal(fee.requiresFullCalendar, true);
    assert.equal(fee.rawDueDate, "2027-08-15");
    assert.equal(fee.dueDate, undefined);
    assert.equal(fee.dueDateLowerBound, "2027-08-16");
    assert.ok(fee.calendarCaveat?.includes("2027"));
  });

  it("下界是**安全保守值**：只可能早于或等于真实届满日", () => {
    // 下界 = 仅按周末顺延（周末是法定休假日的子集），故顺延只会更靠后。
    const report = evaluate(base({ filingDate: d("2027-06-15") }));
    const fee = computed(report, "application-fee-from-filing");
    assert.ok((fee.dueDateLowerBound ?? "") >= fee.rawDueDate);
  });

  it("报告列出日历已覆盖年份，供调用方判断降级影响面", () => {
    const report = evaluate(base());
    assert.ok(report.calendarCoveredYears.includes(2026));
  });
});

describe("patent/deadline/statutes 优先权与实审请求", () => {
  it("优先权期限：发明 12 个月、外观设计 6 个月", () => {
    const invention = computed(evaluate(base({ filingDate: d("2026-08-15") })), "priority-window");
    assert.equal(invention.rawDueDate, "2027-08-15");
    assert.equal(invention.legalBasis, "专利法第29条第1款");

    const design = computed(evaluate(base({ kind: "design", filingDate: d("2026-08-15") })), "priority-window");
    assert.equal(design.rawDueDate, "2027-02-15");
    assert.equal(design.legalBasis, "专利法第29条第2款");
  });

  it("优先权期限标出恢复排除（细则第 6 条第 5 款）", () => {
    const window = computed(evaluate(base()), "priority-window");
    assert.match(window.restorationExcluded ?? "", /第6条第5款/);
    assert.match(computed(evaluate(base()), "patent-term").restorationExcluded ?? "", /第6条第5款/);
  });

  it("专利权期限：发明 20 年、实用新型 10 年、外观设计 15 年（专利法第 42 条第 1 款）", () => {
    assert.equal(computed(evaluate(base()), "patent-term").rawDueDate, "2046-08-15");
    assert.equal(computed(evaluate(base({ kind: "utility-model" })), "patent-term").rawDueDate, "2036-08-15");
    assert.equal(computed(evaluate(base({ kind: "design" })), "patent-term").rawDueDate, "2041-08-15");
  });

  it("实审请求：发明专利 3 年，主张优先权时自优先权日起算", () => {
    assert.equal(
      computed(evaluate(base({ filingDate: d("2026-08-15") })), "substantive-exam-request").rawDueDate,
      "2029-08-15",
    );
    const withPriority = computed(
      evaluate(base({ claimsPriority: true, priorityDate: d("2026-03-01"), filingDate: d("2026-08-15") })),
      "substantive-exam-request",
    );
    assert.equal(withPriority.rawDueDate, "2029-03-01");
    assert.match(withPriority.label, /自优先权日起3年/);
  });

  it("实用新型与外观设计没有实审请求期限", () => {
    const utility = evaluate(base({ kind: "utility-model" }));
    assert.equal(
      utility.computed.find(e => e.id === "substantive-exam-request"),
      undefined,
    );
    const design = evaluate(base({ kind: "design" }));
    assert.equal(
      design.computed.find(e => e.id === "substantive-exam-request"),
      undefined,
    );
  });

  it("增加或改正优先权要求取「自优先权日起16个月」与「自申请日起4个月」的较晚者", () => {
    // 优先权日 2026-03-01 +16月 = 2027-07-01；申请日 2026-08-15 +4月 = 2026-12-15 → 取前者。
    const entry = computed(
      evaluate(base({ claimsPriority: true, priorityDate: d("2026-03-01"), filingDate: d("2026-08-15") })),
      "priority-addition-or-correction",
    );
    assert.equal(entry.rawDueDate, "2027-07-01");

    // 兜底分支：优先权日足够早时，「自申请日起4个月」反而更晚（优先权正常在 12 个月内时该分支
    // 不常胜出，但它必须存在，否则早优先权的案子会算出一个偏早的届满日）。
    const later = computed(
      evaluate(base({ claimsPriority: true, priorityDate: d("2025-01-10"), filingDate: d("2026-08-15") })),
      "priority-addition-or-correction",
    );
    assert.equal(later.rawDueDate, "2026-12-15");
  });

  it("未主张优先权时不产出「增加或改正优先权要求」", () => {
    const report = evaluate(base());
    assert.equal(
      report.computed.find(e => e.id === "priority-addition-or-correction"),
      undefined,
    );
  });
});

describe("patent/deadline/statutes 年费（细则第 115 条）", () => {
  const query = base({
    filingDate: d("2020-01-15"),
    authorizationPublicationDate: d("2022-06-20"),
  });

  it("未给授权公告日时为 pending 并指名该输入", () => {
    const entry = pending(evaluate(base({ filingDate: d("2020-01-15") })), "annual-fee");
    assert.match(entry.requiredInput, /authorizationPublicationDate/);
  });

  it("第 N 年度年费的缴费期限 = 申请日 + (N−1)×12 个月（上一年度期满前）", () => {
    const report = evaluate(query);
    // 授权当年（2022-06-20 落在第 3 专利年度）之后的年费从第 4 年度起。
    const year4 = computed(report, "annual-fee-4");
    assert.equal(year4.patentYear, 4);
    assert.equal(year4.rawDueDate, "2023-01-15");
    const year5 = computed(report, "annual-fee-5");
    assert.equal(year5.rawDueDate, "2024-01-15");
  });

  it("⚠️ 与「第 N 年度本身的期满日」差一年——这是本模块最容易抄错的一处", () => {
    const year5 = computed(evaluate(query), "annual-fee-5");
    // 第 5 年度本身期满于 2025-01-15；缴费期限是 2024-01-15（第 4 年度期满前）。
    assert.equal(year5.rawDueDate, "2024-01-15");
    assert.notEqual(year5.rawDueDate, "2025-01-15");
  });

  it("滞纳窗口：应缴年费期满日起 6 个月，每超 1 个月加收 5%", () => {
    const year5 = computed(evaluate(query), "annual-fee-5");
    assert.ok(year5.latePaymentWindow !== undefined);
    assert.equal(year5.latePaymentWindow.from, "2024-01-15");
    assert.equal(year5.latePaymentWindow.to, "2024-07-15");
    assert.equal(year5.latePaymentWindow.months, 6);
    assert.equal(year5.latePaymentWindow.monthlyRate, 0.05);
  });

  it("只报基准日之后两年窗口内的年度", () => {
    const report = evaluate(query);
    const years = report.computed.filter(entry => entry.id.startsWith("annual-fee-")).map(entry => entry.patentYear);
    assert.deepEqual(years, [4, 5, 6, 7, 8, 9]);
  });
});

describe("patent/deadline/statutes PCT 进入中国国家阶段", () => {
  it("非国家阶段申请不产出 PCT 期限", () => {
    const report = evaluate(base());
    assert.equal(
      report.computed.find(e => e.id === "pct-national-entry"),
      undefined,
    );
  });

  it("国家阶段申请产出 30 个月与 32 个月两条", () => {
    const report = evaluate(
      base({
        isPctNationalPhase: true,
        claimsPriority: true,
        priorityDate: d("2024-03-01"),
        filingDate: d("2024-09-01"),
      }),
    );
    assert.equal(computed(report, "pct-national-entry").rawDueDate, "2026-09-01");
    assert.equal(computed(report, "pct-national-entry-grace").rawDueDate, "2026-11-01");
  });

  it("未主张优先权时自国际申请日起算", () => {
    const report = evaluate(base({ isPctNationalPhase: true, filingDate: d("2025-01-10") }));
    const entry = computed(report, "pct-national-entry");
    assert.equal(entry.rawDueDate, "2027-07-10");
  });
});

describe("patent/deadline/statutes 报告装配", () => {
  it("computed 按届满日升序，pending 按 id 升序", () => {
    const report = evaluate(
      base({
        filingDate: d("2020-01-15"),
        authorizationPublicationDate: d("2022-06-20"),
      }),
    );
    const keys = report.computed.map(entry => entry.dueDate ?? entry.dueDateLowerBound ?? entry.rawDueDate);
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted);
    const pendingIds = report.pending.map(entry => entry.id);
    assert.deepEqual(pendingIds, [...pendingIds].sort());
  });

  it("同日届满的两条期限都出，不合并", () => {
    const report = evaluate(
      base({
        notices: [{ kind: "grant-notice", delivery: { dispatchDate: d("2026-09-01") } }],
      }),
    );
    const sameDay = report.computed.filter(entry => entry.rawDueDate === "2026-11-01");
    assert.equal(sameDay.length, 2);
  });

  it("专利类型中文名", () => {
    assert.equal(describePatentKind("invention"), "发明专利");
    assert.equal(describePatentKind("utility-model"), "实用新型专利");
    assert.equal(describePatentKind("design"), "外观设计专利");
  });
});
