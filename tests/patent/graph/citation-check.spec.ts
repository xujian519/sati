import assert from "node:assert/strict";
import test from "node:test";
import { checkCitations, extractCitationIds } from "../../../src/patent/graph/domains/citation-check.js";
import { ruleGateNode } from "../../../src/patent/graph/domains/shared.js";

test("extractCitationIds: 专利号优先提取（document/candidate_documents 场景）", () => {
  assert.deepEqual(extractCitationIds("最接近现有技术为 US11452699B2"), ["US11452699B2"]);
  assert.deepEqual(extractCitationIds("CN108916716A 与 WO2020123456A1 均可结合"), ["CN108916716A", "WO2020123456A1"]);
  // 专利号存在时不回退文档标识。
  assert.deepEqual(extractCitationIds("D2 为 US11452699B2"), ["US11452699B2"]);
});

test("extractCitationIds: 无专利号时归一文档标识（对比文件N/证据N/D<N>）", () => {
  assert.deepEqual(extractCitationIds("对比文件2 公开了该特征"), ["D2"]);
  assert.deepEqual(extractCitationIds("证据1"), ["D1"]);
  assert.deepEqual(extractCitationIds("结合 D3"), ["D3"]);
  assert.deepEqual(extractCitationIds("仅一篇候选"), []);
});

test("checkCitations: 引用专利号全部接地 → grounded（url 含专利号）", () => {
  const result = checkCitations({
    refTexts: ['{"document":"US11452699B2","rationale":"r"}'],
    docs: [{ title: "标题", snippet: "s", url: "https://patents.google.com/patent/US11452699B2" }],
  });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.uncited, []);
});

test("checkCitations: 引用不在 prior_art → uncited 列出（needs_revision 依据）", () => {
  const result = checkCitations({
    refTexts: ['{"document":"US9999999B2","rationale":"r"}'],
    docs: [{ title: "标题", snippet: "s", url: "https://patents.google.com/patent/US11452699B2" }],
  });
  assert.equal(result.grounded, false);
  assert.deepEqual(result.uncited, ["US9999999B2"]);
  assert.ok(result.report.includes("US9999999B2"));
});

test("checkCitations: hint.evidence 自由文本仅提取专利号，不做标题硬匹配", () => {
  const result = checkCitations({
    refTexts: ['{"evidence":["US11452699B2 第 3 段公开了该特征","标题为《空气净化》的对比文件"]}'],
    docs: [{ title: "标题", snippet: "s", url: "https://patents.google.com/patent/US11452699B2" }],
  });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.uncited, []);
});

test("checkCitations: prior_art 为空 → 跳过硬校验（不双重惩罚）", () => {
  const result = checkCitations({ refTexts: ['{"document":"US9999999B2"}'], docs: [] });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.uncited, []);
  assert.ok(result.report.includes("跳过"));
});

test("checkCitations: 引用无专利号但检索结果有专利号 → 未接地（D1 无法追溯）", () => {
  const result = checkCitations({
    refTexts: ['{"document":"D1","rationale":"r"}'],
    docs: [{ title: "标题", snippet: "s", url: "https://patents.google.com/patent/US11452699B2" }],
  });
  assert.equal(result.grounded, false);
  assert.deepEqual(result.uncited, ["D1"]);
});

test("checkCitations: 双方均无标识 → 跳过（无法校验不误报）", () => {
  const result = checkCitations({
    refTexts: ['{"document":"D1","rationale":"r"}'],
    docs: [{ title: "某文献标题", snippet: "s", url: "https://example.com/1" }],
  });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.uncited, []);
  assert.ok(result.report.includes("无法提取标识"));
});

test("checkCitations: 文档标识归一比对（对比文件2 ↔ title 含对比文件2）", () => {
  const result = checkCitations({
    refTexts: ['{"document":"对比文件2","rationale":"r"}'],
    docs: [{ title: "对比文件2 公开结构", snippet: "s", url: "https://example.com/2" }],
  });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.uncited, []);
});

// ---------------------------------------------------------------------------
// ruleGateNode precomputedFailures 合并规则（P1-2）
// ---------------------------------------------------------------------------

test("ruleGateNode: 无 precomputedFailures 行为不变（pass 基线）", async () => {
  // 不存在的域 → 全部规则被域过滤跳过 → pass 基线（验证合并逻辑的 verdict 转换）。
  const node = ruleGateNode(["__no_rules__"], []);
  const delta = await node({ state: { x: "文本" }, provider: undefined });
  assert.equal(delta.rule_gate_verdict, "pass");
  assert.deepEqual(delta.rule_gate_failures, []);
});

test("ruleGateNode: 既有 pass 且存在预计算失败 → needs_revision + failures 合并", async () => {
  const node = ruleGateNode(["__no_rules__"], ["US9999999B2"]);
  const delta = await node({ state: { x: "文本" }, provider: undefined });
  assert.equal(delta.rule_gate_verdict, "needs_revision");
  assert.ok((delta.rule_gate_failures as string[]).includes("US9999999B2"));
});

test("ruleGateNode: 既有 blocked 保持 blocked（引用失败不升级判级）", async () => {
  const node = ruleGateNode(["patent_inventiveness"], ["US9999999B2"]);
  const delta = await node({ state: { x: "结论：具备创造性" }, provider: undefined });
  assert.equal(delta.rule_gate_verdict, "blocked");
  assert.ok((delta.rule_gate_failures as string[]).includes("US9999999B2"), "引用失败并入 rule_gate_failures");
});

test("ruleGateNode: 无预计算失败时 novelty/enablement 判级不受影响（不传 = 空数组）", async () => {
  const node = ruleGateNode(["patent_novelty"]);
  const delta = await node({ state: { x: "不具备新颖性" }, provider: undefined });
  assert.equal(delta.rule_gate_verdict, "blocked");
  assert.ok(!(delta.rule_gate_failures as string[]).includes("US9999999B2"));
});
