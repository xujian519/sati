import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFees, DEFAULT_FEE_POLICY } from "../../../src/patent/fees/compute.js";
import { loadFeeTable } from "../../../src/patent/fees/fees.js";
import { renderFeeReport, type FeeReportMeta } from "../../../src/patent/fees/report.js";
import type { FeeQuery, FeeReport } from "../../../src/patent/fees/types.js";

const table = loadFeeTable();
const PLAIN_FILING = { claims: 10, specificationPages: 30, priorityClaims: 0 } as const;

/** 计价并渲染，返回报告与 Markdown。 */
function render(query: FeeQuery, failOnUnverified = true): { report: FeeReport; text: string } {
  const report = computeFees(table, query, { policy: { ...DEFAULT_FEE_POLICY, failOnUnverified } });
  const meta: FeeReportMeta = {
    patentType: query.patentType,
    triggers: query.triggers,
    sourceDoc: table.sourceDoc,
    revision: table.revision,
    verifiedOn: table.verifiedOn,
  };
  return { report, text: renderFeeReport(report, meta) };
}

describe("patent/fees/report", () => {
  it("头部写明类型、币种、计价环节与费率依据（含核验日期）", () => {
    const { text } = render({ patentType: "invention", triggers: ["filing"], ...PLAIN_FILING });
    assert.match(text, /^# 官费计价（发明，CNY）/);
    assert.match(text, /\*\*计价环节\*\*：filing/);
    assert.match(text, /未点到的环节\*\*一律不计价\*\*/);
    assert.match(text, /逐条核对于 2026-10-15/);
  });

  it("未给合计时先说明、指名是哪些行，并明确禁止把行相加当价格", () => {
    const { text } = render({
      patentType: "invention",
      triggers: ["filing"],
      claims: 12,
      specificationPages: 40,
      priorityClaims: 0,
    });
    assert.match(text, /\*\*本次未给出合计\*\*/);
    assert.match(text, /specification-surcharge/);
    assert.match(text, /不要把上面任何一行的数字相加当成案子的价格/);
    assert.doesNotMatch(text, /\*\*合计（全部已核验）\*\*/);
  });

  it("全部已核验时给出合计", () => {
    const { text } = render({
      patentType: "invention",
      triggers: ["filing"],
      claims: 12,
      specificationPages: 30,
      priorityClaims: 0,
    });
    assert.match(text, /\*\*合计（全部已核验）\*\*：1250\.00 CNY/);
  });

  it("关了 failOnUnverified 时给的是「部分合计」，并声明这不是价格", () => {
    const { text } = render(
      { patentType: "invention", triggers: ["filing", "extension"], extensionMonths: 1, ...PLAIN_FILING },
      false,
    );
    assert.match(text, /\*\*部分合计\*\*：950\.00 CNY（仅含已核验项；extension-fee 未计入）/);
    assert.match(text, /这不是案子的价格/);
  });

  it("没有任何可计价条目时：明说 0 元不是答案，并给出为什么没有", () => {
    const { text } = render({ patentType: "invention", triggers: ["grant-registration"] });
    assert.match(text, /本次没有可计价的费用条目/);
    assert.match(text, /\*\*这不等于本案没有费用\*\*/);
    assert.match(text, /\*\*本次未给出合计\*\*/);
    assert.match(text, /\*\*0 元不是答案\*\*/);
    assert.match(text, /专利登记费、公告印刷费已由财税〔2018〕37号/);
  });

  it("减缴段写明资格、人数、比例由来与是否真正作用到费用项", () => {
    const { text } = render({
      patentType: "utility-model",
      triggers: ["filing"],
      ...PLAIN_FILING,
      reduction: { kind: "individual", applicants: 2, filed: true },
    });
    assert.match(text, /\*\*费用减缴\*\*/);
    assert.match(text, /申请人\/专利权人 2 名/);
    assert.match(text, /共同申请（申请人\/专利权人 2 名）→ 减缴 70%/);
    assert.match(text, /是否作用到费用项：是/);
  });

  it("待补输入段列出缺的输入，并声明这些条目已挡住合计", () => {
    const { text } = render({ patentType: "invention", triggers: ["filing"], claims: 12, priorityClaims: 0 });
    assert.match(text, /\*\*待补输入\*\*（本工具不自行推算，且这些条目已挡住合计）/);
    assert.match(text, /说明书附加费（specification-surcharge）：需要 `specificationPages`/);
  });

  it("说明段把行级口径提示也带出来", () => {
    const { text } = render({ patentType: "invention", triggers: ["annual-fee"], annuityYears: [1], lateMonths: 6 });
    assert.match(text, /\*\*说明\*\*/);
    assert.match(text, /年费滞纳金（第 1 年度）（annual-fee-1-late-payment）/);
    assert.match(text, /官方年费计算参考表只列到 5 个月（25%）/);
  });

  it("金额出处段只列真正出现了数字的行，并标出未核验", () => {
    const { text } = render({ patentType: "invention", triggers: ["filing"], ...PLAIN_FILING });
    assert.match(text, /\*\*金额出处\*\*（逐条可回原文核对）：/);
    assert.match(text, /weihuRid=286/);
    assert.match(text, /发布 2024-08-06｜核对 2026-10-15/);
    assert.doesNotMatch(text, /核对 \*\*未核验\*\*/);
  });

  it("行表把未核验行的金额列写成 —（而不是 0）", () => {
    const { text } = render({ patentType: "invention", triggers: ["extension"], extensionMonths: 2 });
    assert.match(text, /延长期限请求费 \| 2 个月 \| 2 \| — \| — \| — \| 金额未转录 \|/);
  });
});
