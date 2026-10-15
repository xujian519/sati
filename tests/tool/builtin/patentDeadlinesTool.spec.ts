import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPatentDeadlinesTool } from "../../../src/tool/builtin/patentDeadlines.js";
import { makeToolContext } from "../context-fixture.js";

describe("patent_deadlines 工具面", () => {
  it("定义完整、只读、可用", async () => {
    const tool = createPatentDeadlinesTool();
    assert.equal(tool.name, "patent_deadlines");
    assert.equal(tool.domain, "patent");
    assert.equal(tool.isReadOnly({ kind: "invention", filingDate: "2026-01-10", claimsPriority: false }), true);
    assert.ok(tool.outputSchema !== undefined, "必须声明 outputSchema");
    const availability = (await tool.checkAvailability?.(
      {} as unknown as Parameters<NonNullable<typeof tool.checkAvailability>>[0],
    )) as { ok: boolean } | undefined;
    assert.ok(availability?.ok, "随包节假日资产应可装载");
  });

  it("正常调用返回结构化结果与 Markdown 报告", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      {
        kind: "invention",
        filingDate: "2026-08-15",
        claimsPriority: false,
        today: "2026-10-15",
        notices: [{ kind: "grant-notice", dispatchDate: "2026-09-01" }],
      },
      makeToolContext(),
    );
    assert.ok(result.data !== undefined);
    assert.equal(result.data.kind, "invention");
    assert.equal(result.data.today, "2026-10-15");
    assert.equal(result.data.claimsPriority, false);
    assert.ok(result.data.calendarCoveredYears.includes(2026));
    // 办登与分案：送达 2026-09-01 起 2 个月，本体 2026-11-01（周日）→ 2026-11-02。
    const registration = result.data.computed.find(entry => entry.id === "registration");
    assert.ok(registration !== undefined);
    assert.equal(registration.rawDueDate, "2026-11-01");
    assert.equal(registration.dueDate, "2026-11-02");
    assert.match(result.data.report, /办理登记手续/);
  });

  it("缺省 today 时按服务器当天（不崩溃、日期格式正确）", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      { kind: "utility-model", filingDate: "2026-01-10", claimsPriority: false },
      makeToolContext(),
    );
    assert.ok(result.data !== undefined);
    assert.match(result.data.today, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("缺授权通知时报告里出现 pending 与所缺输入名", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      { kind: "invention", filingDate: "2026-08-15", claimsPriority: false, today: "2026-10-15" },
      makeToolContext(),
    );
    assert.ok(result.data !== undefined);
    assert.ok(result.data.pending.some(entry => entry.id === "registration"));
    assert.match(result.data.report, /grant-notice/);
    assert.match(result.data.report, /不以固定年数代替通知书送达日/);
  });

  it("非法日期返回可读错误而不是抛出", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      { kind: "invention", filingDate: "2026-02-30", claimsPriority: false },
      makeToolContext(),
    );
    assert.equal(result.data, undefined);
    assert.equal(result.metadata?.error, "invalid_query");
    assert.match((result.content[0] as { text: string }).text, /filingDate 不是有效日期/);
  });

  it("优先权输入矛盾返回可读错误", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      { kind: "invention", filingDate: "2026-08-15", claimsPriority: true },
      makeToolContext(),
    );
    assert.equal(result.metadata?.error, "invalid_query");
    assert.match((result.content[0] as { text: string }).text, /未提供优先权日/);
  });

  it("送达记录缺该方式必需字段时返回可读错误", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      {
        kind: "invention",
        filingDate: "2026-08-15",
        claimsPriority: false,
        notices: [{ kind: "grant-notice", mode: "postal" }],
      },
      makeToolContext(),
    );
    assert.equal(result.metadata?.error, "invalid_query");
    assert.match((result.content[0] as { text: string }).text, /邮寄送达需要发文日/);
  });

  it("电子送达不加 15 日（工具面端到端）", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      {
        kind: "invention",
        filingDate: "2026-08-15",
        claimsPriority: false,
        today: "2026-10-15",
        notices: [{ kind: "office-action-first", mode: "electronic", dispatchDate: "2026-09-01" }],
      },
      makeToolContext(),
    );
    assert.ok(result.data !== undefined);
    const oa = result.data.computed.find(entry => entry.id === "oa-response-first");
    assert.ok(oa !== undefined);
    // 电子送达自 2026-09-01 起算 4 个月 → 2027-01-01；若误加 15 日会是 2027-01-16。
    assert.equal(oa.rawDueDate, "2027-01-01");
  });

  it("metadata 带条目计数，便于日志核对", async () => {
    const tool = createPatentDeadlinesTool();
    const result = await tool.execute(
      { kind: "invention", filingDate: "2026-08-15", claimsPriority: false, today: "2026-10-15" },
      makeToolContext(),
    );
    assert.equal(typeof result.metadata?.computed, "number");
    assert.equal(typeof result.metadata?.pending, "number");
  });
});
