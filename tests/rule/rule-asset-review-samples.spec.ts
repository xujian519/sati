/**
 * 规则资产评审样本（可执行版）——`rules/README.md`「nuo 规则激活评审」章节的样本表。
 *
 * 用途：把评审结论（判定 + 依据 + 样本）钉成判据，避免结论只活在文档里腐烂。
 * 每条样本独立成一个 `test`：负控制时可逐条对名（哪条判据转红 = 哪处注入生效），
 * 且相邻样本应保持绿（证明判据有区分度）。
 *
 * 本轮样本对应 issue #357（规则资产语义增强 3 项）：
 *   ① X-REF-003 全角/大小写变体漏报 → 补关键词（addKeywords 补丁）
 *   ② EX-SEL-004 误伤合法安防主题 → 开否定语境 + 4 个领域放行词
 *   ③ EX-INV-007 / IPC-GEN-INV-002 重复 → 后者降 log（同一问题只留一条用户可见意见）
 * 另含两条「域词不外溢」样本：证明 additionalNegationWords 是**逐规则**的，
 * 把它们塞进全局词表会让其它规则的判定转红。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateText, loadPatentFullRuleSet, RuleOutputGate } from "../../src/rule/index.js";

/** 判定一段文本命中的规则 id 集合。 */
function hitIds(text: string): string[] {
  const { ruleSet } = loadPatentFullRuleSet();
  return evaluateText(text, ruleSet).violations.map(v => v.ruleId);
}

function hitAction(text: string, ruleId: string): string | undefined {
  const { ruleSet } = loadPatentFullRuleSet();
  return evaluateText(text, ruleSet).violations.find(v => v.ruleId === ruleId)?.action;
}

// ---------------------------------------------------------------------------
// ① X-REF-003：占位案例案号的 12 种拼写（3 案号族 × 4 拼写）
//    原 asset 只有「半角大写」3 条 ⇒ 另 9 种为漏报（issue #357 第 1 项）。
// ---------------------------------------------------------------------------

/** 补丁新增的 9 个变体：每个变体 = `addKeywords` 里的一条 OR 备选。 */
const NEW_VARIANTS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "最高法知民终 · 全角大写", text: "参见（202X）最高法知民终999号判决。" },
  { label: "最高法知民终 · 半角小写", text: "参见(202x)最高法知民终999号判决。" },
  { label: "最高法知民终 · 全角小写", text: "参见（202x）最高法知民终999号判决。" },
  { label: "京73民初 · 全角大写", text: "参见（202X）京73民初888号判决。" },
  { label: "京73民初 · 半角小写", text: "参见(202x)京73民初888号判决。" },
  { label: "京73民初 · 全角小写", text: "参见（202x）京73民初888号判决。" },
  { label: "最高法知行终 · 全角大写", text: "参见（202X）最高法知行终77号判决。" },
  { label: "最高法知行终 · 半角小写", text: "参见(202x)最高法知行终77号判决。" },
  { label: "最高法知行终 · 全角小写", text: "参见（202x）最高法知行终77号判决。" },
];

for (const sample of NEW_VARIANTS) {
  test(`X-REF-003 命中占位案号变体（#357 补漏报）：${sample.label}`, () => {
    assert.ok(hitIds(sample.text).includes("X-REF-003"), `应命中 X-REF-003：${sample.text}`);
  });
}

test("X-REF-003 半角大写占位案号仍命中（拼写覆盖不得回退）", () => {
  // 本用例是**行为回归**：只要「半角大写」这种拼写仍被覆盖即可通过——不区分由基础资产
  // 条目覆盖还是由补丁 OR 组覆盖（两者**有意**重叠：OR 组自包含，故基础条目被重新移植
  // 改写时变体覆盖不会失守）。"补丁是增补而非替换" 由 patent-full-rule-set.spec.ts 的
  // 补丁落地用例按结构钉住（负控制 M13）。
  for (const text of [
    "参见(202X)最高法知民终999号判决。",
    "参见(202X)京73民初888号判决。",
    "参见(202X)最高法知行终77号判决。",
  ]) {
    assert.ok(hitIds(text).includes("X-REF-003"), `应命中 X-REF-003：${text}`);
  }
});

test("X-REF-003 误拦面不扩大：真实案号（数字年份）全/半角均放行", () => {
  for (const text of [
    "参见（2020）最高法知民终123号判决。",
    "参见(2020)最高法知民终123号判决。",
    "参见（2019）京73民初1234号判决。",
    "参见（2021）最高法知行终959号判决。",
  ]) {
    assert.equal(hitIds(text).includes("X-REF-003"), false, `不应命中 X-REF-003：${text}`);
  }
});

// ---------------------------------------------------------------------------
// ② EX-SEL-004：合法安防主题放行（4 个领域放行词各承重）
// ---------------------------------------------------------------------------

/** 应放行的合法安防/检测主题：每条对应 `additionalNegationWords` 里的一个词。 */
const EX_SEL_004_EXEMPT: ReadonlyArray<{ label: string; text: string }> = [
  { label: "裸「防」：防窃听装置", text: "本发明提供一种防窃听装置。" },
  { label: "裸「反」：反窃听系统", text: "本发明提供一种反窃听系统。" },
  { label: "「抑制」：抑制赌博行为", text: "本发明用于抑制赌博行为的方法。" },
  { label: "「检测」（前置）：检测窃听行为", text: "本发明涉及用于检测窃听行为的设备。" },
  {
    label: "默认词表仍叠加生效：避免…克隆人",
    text: "文中应避免使用克隆人相关表述。",
  },
  { label: "默认词表（开关承重）：防止窃听", text: "本方案用于防止窃听。" },
];

for (const sample of EX_SEL_004_EXEMPT) {
  test(`EX-SEL-004 放行合法主题（#357 补误伤）：${sample.label}`, () => {
    assert.equal(hitIds(sample.text).includes("EX-SEL-004"), false, `不应命中 EX-SEL-004：${sample.text}`);
  });
}

test("EX-SEL-004 放行面不外溢：真实违规主题仍命中", () => {
  for (const text of ["本装置可用于赌博。", "本方法使用克隆人胚胎。", "该系统用于窃听他人通话。"]) {
    assert.ok(hitIds(text).includes("EX-SEL-004"), `应命中 EX-SEL-004：${text}`);
  }
});

test("EX-SEL-004 已登记非对称性：否定语境只查命中位置之前，后缀式「窃听检测」仍命中", () => {
  // 否定语境（negationContext / additionalNegationWords）的窗口在命中位置**之前**且不跨句界，
  // 故「窃听检测方法」中的「检测」不构成豁免。这是既有语义的有意保留（改它等于把否定语境
  // 扩成双向，会同步放大所有否定语境规则的放行面）。此断言把该非对称性钉成显式事实，
  // 将来若引入后置语境豁免，此用例应改为断言放行。
  assert.ok(hitIds("本发明涉及窃听检测方法。").includes("EX-SEL-004"));
});

// ---------------------------------------------------------------------------
// ③ EX-INV-007 / IPC-GEN-INV-002：重复项只留一条用户可见意见
// ---------------------------------------------------------------------------

const DUP_PAIR = ["EX-INV-007", "IPC-GEN-INV-002"] as const;

for (const sample of [
  { label: "中文", text: "该论述存在事后诸葛亮之嫌。" },
  { label: "英文", text: "This reasoning is hindsight." },
]) {
  test(`去重(#357)：${sample.label}样本在输出门禁只产出一条该问题的提示`, () => {
    const { ruleSet } = loadPatentFullRuleSet();
    const gate = new RuleOutputGate(ruleSet);
    const result = gate.process(sample.text);

    // 用户可见（warn 级）的只剩一条
    const visible = result.warnHits.filter(id => (DUP_PAIR as readonly string[]).includes(id));
    assert.deepEqual(visible, ["EX-INV-007"], "同一问题应只由 EX-INV-007 产出可见提示");

    // 重复项本身未消失，只是降为 log（record-only，不改文本、不挂审批）
    assert.equal(hitAction(sample.text, "IPC-GEN-INV-002"), "log", "IPC-GEN-INV-002 应降级为 log");
    assert.equal(result.needsApproval, false, "log 级不得挂审批");
  });
}

// ---------------------------------------------------------------------------
// ④ 域词不外溢：additionalNegationWords 是逐规则的，不是全局共享词表
//    若把「防/反/抑制/检测」塞进 DEFAULT_NEGATION_WORDS，下面两条会转红。
// ---------------------------------------------------------------------------

test("域禁词不外溢：PAT-RISK-001 的「侵权」不被「检测」前缀豁免", () => {
  // 「检测」若是全局否定词，「经检测，该产品构成侵权」会被判为否定语境而漏报风险结论。
  assert.ok(hitIds("经检测，该产品构成侵权。").includes("PAT-RISK-001"));
});

test("域禁词不外溢：PAT-ABS-001 的「绝对」不被「反」前缀豁免", () => {
  // 「反」若是全局否定词，「反对绝对化表述」会被判为否定语境而漏报。
  assert.ok(hitIds("反对绝对化表述。").includes("PAT-ABS-001"));
});
