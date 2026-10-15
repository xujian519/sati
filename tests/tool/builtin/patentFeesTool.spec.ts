import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPatentFeesTool, resetPatentFeesCache } from "../../../src/tool/builtin/patentFees.js";
import { makeToolContext } from "../context-fixture.js";

const PLAIN_FILING = { claims: 10, specificationPages: 30, priorityClaims: 0 } as const;

describe("patent_fees 工具面", () => {
  it("定义完整、只读、可用、声明 outputSchema", async () => {
    const tool = createPatentFeesTool();
    assert.equal(tool.name, "patent_fees");
    assert.equal(tool.domain, "patent");
    assert.equal(tool.kind, "custom");
    assert.equal(tool.isReadOnly({ patentType: "invention", triggers: ["filing"] }), true);
    assert.ok(tool.outputSchema !== undefined, "必须声明 outputSchema");
    const availability = (await tool.checkAvailability?.(
      {} as unknown as Parameters<NonNullable<typeof tool.checkAvailability>>[0],
    )) as { ok: boolean } | undefined;
    assert.ok(availability?.ok, "随包官费索引应可装载");
  });

  it("正常调用返回结构化结果与 Markdown 清单", async () => {
    resetPatentFeesCache();
    const tool = createPatentFeesTool();
    const result = await tool.execute(
      {
        patentType: "invention",
        triggers: ["filing", "substantive-examination"],
        claims: 12,
        specificationPages: 30,
        priorityClaims: 0,
      },
      makeToolContext(),
    );
    const data = result.data;
    assert.ok(data !== undefined);
    assert.equal(data.patentType, "invention");
    assert.equal(data.currency, "CNY");
    assert.deepEqual(data.triggers, ["filing", "substantive-examination"]);
    assert.equal(data.total.amount, "3750.00"); // 900 + 50 + 300 + 2500
    assert.equal(data.total.complete, true);
    assert.deepEqual(data.total.unverifiedIds, []);
    // 每行都带得出处，便于逐条回原文核对
    const application = data.lines.find(line => line.id === "application-fee");
    assert.equal(application?.subtotal, "900.00");
    assert.equal(application?.verifiedOn, "2026-10-15");
    assert.equal(application?.publishedOn, "2024-08-06");
    assert.match(String(application?.sourceUrl), /weihuRid=286/);
    assert.match(data.report, /^\*\*合计（全部已核验）\*\*：3750\.00 CNY/m);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /官费计价/);
  });

  it("triggers 为空：明确报错（空 triggers 不等于本案无费用）", async () => {
    const tool = createPatentFeesTool();
    const result = await tool.execute({ patentType: "invention", triggers: [] }, makeToolContext());
    assert.equal(result.metadata?.error, "no_triggers");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /triggers 不能为空/);
  });

  it("未知 trigger：报错并列出可用取值", async () => {
    const tool = createPatentFeesTool();
    const result = await tool.execute({ patentType: "invention", triggers: ["grant"] }, makeToolContext());
    assert.equal(result.metadata?.error, "unknown_trigger");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /grant-registration/);
  });

  it("非法计数与非法年费年度：报错", async () => {
    const tool = createPatentFeesTool();
    const badCount = await tool.execute(
      { patentType: "invention", triggers: ["filing"], claims: -1 },
      makeToolContext(),
    );
    assert.equal(badCount.metadata?.error, "invalid_count");
    const badYear = await tool.execute(
      { patentType: "invention", triggers: ["annual-fee"], annuityYears: [0] },
      makeToolContext(),
    );
    assert.equal(badYear.metadata?.error, "invalid_annuity_year");
  });

  it("减缴人数少于 1：报错（人数决定比例，不能含糊）", async () => {
    const tool = createPatentFeesTool();
    const result = await tool.execute(
      {
        patentType: "invention",
        triggers: ["filing"],
        ...PLAIN_FILING,
        reduction: { kind: "individual", applicants: 0, filed: true },
      },
      makeToolContext(),
    );
    assert.equal(result.metadata?.error, "invalid_applicants");
  });

  it("工具面可观测的减缴修正：同一案子单独申请 185.00、共同申请 320.00", async () => {
    const tool = createPatentFeesTool();
    const single = await tool.execute(
      {
        patentType: "invention",
        triggers: ["filing"],
        ...PLAIN_FILING,
        reduction: { kind: "enterprise", applicants: 1, filed: true },
      },
      makeToolContext(),
    );
    const joint = await tool.execute(
      {
        patentType: "invention",
        triggers: ["filing"],
        ...PLAIN_FILING,
        reduction: { kind: "enterprise", applicants: 2, filed: true },
      },
      makeToolContext(),
    );
    assert.equal(single.data?.reduction?.reductionPercent, 85);
    assert.equal(single.data?.total.amount, "185.00");
    assert.equal(joint.data?.reduction?.reductionPercent, 70);
    assert.equal(joint.data?.total.amount, "320.00");
  });

  it("未给年费年度：pending 非空且合计被挡住（不漏算还报 complete）", async () => {
    const tool = createPatentFeesTool();
    const result = await tool.execute(
      { patentType: "invention", triggers: ["filing", "annual-fee"], ...PLAIN_FILING },
      makeToolContext(),
    );
    assert.equal(result.data?.pending.length, 1);
    assert.equal(result.data?.pending[0]?.requiredInput, "annuityYears");
    assert.equal(result.data?.total.amount, undefined);
    assert.equal(result.data?.total.complete, false);
    assert.ok(result.data?.total.unverifiedIds.includes("annual-fee"));
  });

  it("费用减缴的工具面输出带比例由来（不再只看个人/企业）", async () => {
    const tool = createPatentFeesTool();
    const result = await tool.execute(
      {
        patentType: "utility-model",
        triggers: ["filing"],
        ...PLAIN_FILING,
        reduction: { kind: "individual", applicants: 1, filed: true, grantPatentYear: 1 },
      },
      makeToolContext(),
    );
    assert.equal(result.data?.reduction?.reductionBasis, "单独申请（申请人/专利权人 1 名）→ 减缴 85%");
    assert.equal(result.data?.reduction?.applied, true);
    const filing = result.data?.lines.find(line => line.id === "application-fee-utility-design");
    assert.equal(filing?.payable, "75.00");
  });
});
