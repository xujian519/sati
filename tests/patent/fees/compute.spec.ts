import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFees, DEFAULT_FEE_POLICY, type FeePolicy } from "../../../src/patent/fees/compute.js";
import { loadFeeTable } from "../../../src/patent/fees/fees.js";
import type { FeeLine, FeeQuery, FeeReport } from "../../../src/patent/fees/types.js";

const table = loadFeeTable();
const policy: FeePolicy = DEFAULT_FEE_POLICY;

/** 计价并返回报告。 */
function price(query: FeeQuery): FeeReport {
  return computeFees(table, query, { policy });
}

/** 取某一行的可读视图，找不到就断言失败。 */
function line(report: FeeReport, id: string): FeeLine {
  const found = report.lines.find(entry => entry.id === id);
  assert.ok(found !== undefined, `报告里应有 ${id}；实际有 ${report.lines.map(entry => entry.id).join(", ")}`);
  return found;
}

/** 一份没有权利要求/页数/优先权超出免费基数的申请事实。 */
const PLAIN_FILING = { claims: 10, specificationPages: 30, priorityClaims: 0 } as const;

describe("patent/fees/compute — 申请环节计价", () => {
  it("12 项权利要求的发明申请：900 + 50 + 2×150 = 1250.00", () => {
    const report = price({
      patentType: "invention",
      triggers: ["filing"],
      claims: 12,
      specificationPages: 30,
      priorityClaims: 0,
    });
    assert.equal(line(report, "application-fee").subtotal, "900.00");
    assert.equal(line(report, "publication-printing-fee").subtotal, "50.00");
    assert.equal(line(report, "claims-surcharge").quantity, 2);
    assert.equal(line(report, "claims-surcharge").subtotal, "300.00");
    assert.equal(report.total.amount, "1250.00");
    assert.equal(report.total.complete, true);
    assert.deepEqual(report.total.unverifiedIds, []);
  });

  it("实用新型申请：申请费 500.00，公布印刷费不适用（只对发明收取）", () => {
    const report = price({ patentType: "utility-model", triggers: ["filing"], ...PLAIN_FILING });
    assert.equal(line(report, "application-fee-utility-design").subtotal, "500.00");
    assert.equal(
      report.lines.some(entry => entry.id === "publication-printing-fee"),
      false,
    );
    assert.match(report.notes.join("\n"), /申请费（application-fee，适用 发明）/);
  });

  it("份数为 0 的附加费按 0.00 计，且不挡住合计", () => {
    const report = price({ patentType: "invention", triggers: ["filing"], ...PLAIN_FILING });
    const surcharge = line(report, "claims-surcharge");
    assert.equal(surcharge.quantity, 0);
    assert.equal(surcharge.subtotal, "0.00");
    assert.equal(surcharge.status, "verified");
    assert.equal(report.total.complete, true);
  });

  it("说明书超过免费基数时，单价未转录的附加费挡住合计（0 元不是答案）", () => {
    const report = price({
      patentType: "invention",
      triggers: ["filing"],
      claims: 12,
      specificationPages: 40,
      priorityClaims: 0,
    });
    const surcharge = line(report, "specification-surcharge");
    assert.equal(surcharge.quantity, 10);
    assert.equal(surcharge.payable, null);
    assert.equal(surcharge.status, "unrecorded");
    assert.match(surcharge.notes.join("\n"), /第 31 页起每页 50 元/);
    assert.equal(report.total.amount, null);
    assert.equal(report.total.complete, false);
    assert.deepEqual(report.total.unverifiedIds, ["specification-surcharge"]);
  });
});

describe("patent/fees/compute — 缺输入时挡住合计（而不是少算一笔）", () => {
  it("未给说明书页数：报 pending 并挡住合计", () => {
    const report = price({ patentType: "invention", triggers: ["filing"], claims: 12, priorityClaims: 0 });
    assert.deepEqual(
      report.pending.map(item => item.id),
      ["specification-surcharge"],
    );
    assert.equal(report.pending[0]?.requiredInput, "specificationPages");
    assert.equal(report.total.amount, null);
    assert.equal(report.total.complete, false);
    assert.ok(report.total.unverifiedIds.includes("specification-surcharge"));
  });

  it("未给年费年度：报 pending 并挡住合计（不得把年费漏在合计之外还报 complete）", () => {
    const report = price({ patentType: "invention", triggers: ["filing", "annual-fee"], ...PLAIN_FILING });
    assert.equal(report.pending[0]?.id, "annual-fee");
    assert.equal(report.pending[0]?.requiredInput, "annuityYears");
    assert.equal(report.total.amount, null);
    assert.equal(report.total.complete, false);
    assert.ok(report.total.unverifiedIds.includes("annual-fee"));
  });

  it("单价未转录的适用项：不给合计并指名是哪一个", () => {
    const report = price({ patentType: "invention", triggers: ["extension"], extensionMonths: 1 });
    assert.equal(line(report, "extension-fee").status, "unrecorded");
    assert.equal(report.total.amount, null);
    assert.deepEqual(report.total.unverifiedIds, ["extension-fee"]);
  });
});

describe("patent/fees/compute — 费用减缴（比例取决于申请人是一个还是多个）", () => {
  const base: FeeQuery = { patentType: "invention", triggers: ["filing"], ...PLAIN_FILING };

  it("单独申请（1 名）减缴 85%：发明申请费 900 → 135.00", () => {
    const report = price({ ...base, reduction: { kind: "individual", applicants: 1, filed: true } });
    assert.equal(line(report, "application-fee").payable, "135.00");
    assert.equal(line(report, "application-fee").reduction, "减缴 85%");
    assert.equal(report.total.amount, "185.00"); // 135 + 公布印刷费 50（不予减缴）
  });

  it("共同申请（2 名）减缴 70%：同一个案子变成 270.00", () => {
    const report = price({ ...base, reduction: { kind: "individual", applicants: 2, filed: true } });
    assert.equal(line(report, "application-fee").payable, "270.00");
    assert.equal(report.reduction?.reductionPercent, 70);
    assert.match(report.reduction?.reductionBasis ?? "", /共同申请（申请人\/专利权人 2 名）/);
  });

  it("企业**单独**申请也是 85%——比例不看主体类型，只看人数", () => {
    const report = price({ ...base, reduction: { kind: "enterprise", applicants: 1, filed: true } });
    assert.equal(line(report, "application-fee").payable, "135.00");
    assert.equal(report.reduction?.reductionPercent, 85);
  });

  it("事业单位/社会团体/非营利性科研机构是独立的第三类资格", () => {
    const report = price({ ...base, reduction: { kind: "institution", applicants: 1, filed: true } });
    assert.equal(report.reduction?.reductionPercent, 85);
    assert.match(report.reduction?.reason ?? "", /法人证明材料/);
  });

  it("未办费减备案：按全额计，并写明理由（不静默按减缴算）", () => {
    const report = price({ ...base, reduction: { kind: "individual", applicants: 1, filed: false } });
    const application = line(report, "application-fee");
    assert.equal(application.payable, "900.00");
    assert.equal(application.reduction, "未减缴（未备案）");
    assert.match(application.notes.join("\n"), /未办理费减备案/);
    assert.equal(report.reduction?.applied, false);
  });

  it("不予减缴的费种按全额计并说明（公布印刷费）", () => {
    const report = price({ ...base, reduction: { kind: "individual", applicants: 1, filed: true } });
    const printing = line(report, "publication-printing-fee");
    assert.equal(printing.payable, "50.00");
    assert.equal(printing.reduction, "未减缴（不适用）");
    assert.match(printing.notes.join("\n"), /不属于费用减缴范围/);
  });

  it("实用新型申请费 500 单独减缴 → 75.00", () => {
    const report = price({
      patentType: "utility-model",
      triggers: ["filing"],
      ...PLAIN_FILING,
      reduction: { kind: "individual", applicants: 1, filed: true },
    });
    assert.equal(line(report, "application-fee-utility-design").payable, "75.00");
    assert.equal(report.total.amount, "75.00");
  });
});

describe("patent/fees/compute — 年费与滞纳金", () => {
  it("年费第 1/4/13 年度按分档计价：900 + 1200 + 6000 = 8100.00", () => {
    const report = price({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [1, 4, 13] });
    assert.equal(line(report, "annual-fee-1").subtotal, "900.00");
    assert.equal(line(report, "annual-fee-4").subtotal, "1200.00");
    assert.equal(line(report, "annual-fee-13").subtotal, "6000.00");
    assert.equal(report.total.amount, "8100.00");
  });

  it("第 16-20 年度分档：第 20 年度 8000.00", () => {
    const report = price({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [20] });
    assert.equal(line(report, "annual-fee-20").subtotal, "8000.00");
  });

  it("实用新型第 9 年度 2000.00；外观设计第 15 年度 3000.00", () => {
    assert.equal(
      line(
        price({ patentType: "utility-model", triggers: ["annual-fee"], annuityYears: [9] }),
        "annual-fee-utility-model-9",
      ).subtotal,
      "2000.00",
    );
    assert.equal(
      line(price({ patentType: "design", triggers: ["annual-fee"], annuityYears: [15] }), "annual-fee-design-15")
        .subtotal,
      "3000.00",
    );
  });

  it("滞纳金 1–5 个月 = 每年费 5% × 月数（与官方参考表 5%–25% 一致）", () => {
    for (const months of [1, 2, 3, 4, 5]) {
      const report = price({
        patentType: "invention",
        triggers: ["annual-fee"],
        annuityYears: [1],
        lateMonths: months,
      });
      const surcharge = line(report, "annual-fee-1-late-payment");
      assert.equal(surcharge.payable, `${String(45 * months)}.00`, `超期 ${String(months)} 个月`);
      assert.equal(surcharge.status, "verified");
    }
    // 第 5 个月封顶 25% = 225.00，合计 900 + 225 = 1125.00
    const capped = price({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [1], lateMonths: 5 });
    assert.equal(capped.total.amount, "1125.00");
  });

  it("滞纳金第 6 个月：官方参考表只列到 25%，不给金额并说明（挡住合计）", () => {
    const report = price({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [1], lateMonths: 6 });
    const surcharge = line(report, "annual-fee-1-late-payment");
    assert.equal(surcharge.subtotal, null);
    assert.equal(surcharge.payable, null);
    assert.equal(surcharge.status, "unrecorded");
    assert.match(surcharge.notes.join("\n"), /官方年费计算参考表只列到 5 个月（25%）/);
    assert.equal(report.total.amount, null);
    assert.ok(report.total.unverifiedIds.includes("annual-fee-1-late-payment"));
  });

  it("超期超过 6 个月的补缴窗口：说明专利权终止，不给金额", () => {
    const report = price({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [1], lateMonths: 7 });
    const surcharge = line(report, "annual-fee-1-late-payment");
    assert.match(surcharge.notes.join("\n"), /专利权自应当缴纳年费期满之日起终止/);
    assert.equal(surcharge.payable, null);
  });

  it("年费减缴：给授权年度时按「自授予专利权当年起十年内」精确判断", () => {
    const report = price({
      patentType: "invention",
      triggers: ["annual-fee"],
      annuityYears: [6, 15, 16],
      reduction: { kind: "individual", applicants: 1, filed: true, grantPatentYear: 6 },
    });
    assert.equal(line(report, "annual-fee-6").payable, "180.00"); // 第 6 年度在 1200 档 → ×15%
    assert.equal(line(report, "annual-fee-15").payable, "900.00"); // 6000 × 15%
    assert.equal(line(report, "annual-fee-16").payable, "8000.00"); // 窗口外（第 6–15 年度）
    assert.equal(line(report, "annual-fee-16").reduction, "未减缴（仅第 6–15 年度适用）");
    assert.equal(report.total.amount, "9080.00");
  });

  it("未给授权年度：退化为第 10 年度及以前的保守近似，并说明怎么精确", () => {
    const report = price({
      patentType: "invention",
      triggers: ["annual-fee"],
      annuityYears: [10, 11],
      reduction: { kind: "individual", applicants: 1, filed: true },
    });
    assert.equal(line(report, "annual-fee-10").payable, "600.00"); // 4000 × 15%
    assert.equal(line(report, "annual-fee-11").payable, "4000.00");
    assert.match(line(report, "annual-fee-11").notes.join("\n"), /未给授权年度/);
    assert.match(report.notes.join("\n"), /grantPatentYear/);
  });
});

describe("patent/fees/compute — 覆盖面与新增费种", () => {
  it("triggers 里没有条目的环节给出说明，而不是一份空表", () => {
    const report = price({ patentType: "invention", triggers: ["grant-registration"] });
    assert.deepEqual(report.lines, []);
    assert.match(report.notes.join("\n"), /专利登记费、公告印刷费已由财税〔2018〕37号/);
    assert.match(report.notes.join("\n"), /annual-fee/);
    // 覆盖为空不是「已算全」：不给 0.00 的合计。
    assert.equal(report.total.amount, null);
    assert.equal(report.total.complete, false);
  });

  it("专利文件副本证明费 30.00/份", () => {
    const report = price({ patentType: "invention", triggers: ["document-copy"] });
    assert.equal(line(report, "document-copy-fee").subtotal, "30.00");
    assert.equal(report.total.amount, "30.00");
  });

  it("专利权期限补偿：请求费 200.00 可计价，补偿期年费无金额并挡住合计", () => {
    const report = price({ patentType: "invention", triggers: ["term-compensation"] });
    assert.equal(line(report, "term-compensation-request-fee").subtotal, "200.00");
    assert.equal(line(report, "term-compensation-annual-fee").status, "unrecorded");
    assert.match(line(report, "term-compensation-annual-fee").notes.join("\n"), /每年 8000 元/);
    assert.equal(report.total.amount, null);
    assert.deepEqual(report.total.unverifiedIds, ["term-compensation-annual-fee"]);
  });

  it("PCT 国家阶段：单一性恢复费 900.00、优先权恢复费 1000.00，译文改正费无金额", () => {
    const report = price({ patentType: "invention", triggers: ["pct-national-phase"] });
    assert.equal(line(report, "pct-unity-restoration-fee").subtotal, "900.00");
    assert.equal(line(report, "pct-priority-restoration-fee").subtotal, "1000.00");
    assert.equal(line(report, "pct-translation-correction-fee").status, "unrecorded");
    assert.equal(report.total.amount, null);
  });

  it("类型过滤的说明用 id + 名称 + 适用类型区分同名条目", () => {
    const report = price({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [1] });
    const note = report.notes.find(entry => entry.startsWith("已按专利类型过滤")) ?? "";
    assert.match(note, /年费（annual-fee-utility-model，适用 实用新型）/);
    assert.match(note, /年费（annual-fee-design，适用 外观设计）/);
    // 两个同名条目在说明里可区分
    assert.notEqual(note.indexOf("annual-fee-utility-model"), note.indexOf("annual-fee-design"));
  });

  it("全部条目的金额状态：能给出金额的都是已核验", () => {
    const report = price({
      patentType: "invention",
      triggers: [
        "filing",
        "substantive-examination",
        "annual-fee",
        "reexamination",
        "invalidation",
        "evaluation-report",
        "restoration",
        "record-change",
        "pct-grace",
      ],
      ...PLAIN_FILING,
      annuityYears: [1],
    });
    assert.equal(report.total.complete, true);
    assert.equal(report.total.amount, "10550.00"); // 900+50+0+0+0+2500+900+1000+3000+1000+200+1000
    assert.ok(report.lines.every(entry => entry.status === "verified"));
  });
});
