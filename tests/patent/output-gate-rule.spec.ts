import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { extractMessageText, PatentOutputGate } from "../../src/patent/output-gate.js";
import { loadPatentFullRuleSet, RuleOutputGate, selectGateRules } from "../../src/rule/index.js";

function assistantMessage(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** 构造 B 链规则门禁：keyword_blocklist 子集（排除 compliance PAT-* 与 structural）。 */
function makeRuleGate(): RuleOutputGate {
  return new RuleOutputGate(selectGateRules(loadPatentFullRuleSet().ruleSet));
}

test("selectGateRules 只保留 nuo 的 keyword_blocklist（排除 PAT-* 与 structural）", () => {
  const gateRules = selectGateRules(loadPatentFullRuleSet().ruleSet);
  assert.equal(gateRules.rules.length, 9, "nuo 9 条 keyword_blocklist");
  for (const r of gateRules.rules) {
    assert.equal(r.check.type, "keyword_blocklist", `${r.id} 应为 keyword_blocklist`);
    assert.ok(!r.id.startsWith("PAT-"), `${r.id} 不应是 compliance 规则`);
  }
});

test("规则门禁 block 命中（占位专利号）→ 挂起审批 + ruleViolations", () => {
  const pendings: Array<{ ruleViolations?: unknown[] }> = [];
  const gate = new PatentOutputGate({
    ruleGate: makeRuleGate(),
    onPending: p => {
      pendings.push(p);
    },
  });
  const msg = assistantMessage("现有技术 CNXXXXXX 公开了一种方法。");
  const result = gate.processMessage(msg, { sessionId: "s1", turnId: "t1" });
  assert.equal(result.needsApproval, true);
  assert.ok(result.pendingIndex !== undefined);
  gate.flushPending(result.pendingIndex!);
  assert.equal(pendings.length, 1);
  const violationIds = pendings[0].ruleViolations?.map(v => (v as { ruleId: string }).ruleId) ?? [];
  assert.ok(violationIds.includes("CON-COMP-0101"), "ruleViolations 应含占位专利号规则");
});

test("规则门禁 warn 命中（清楚性用语）→ 追加提示、不挂起", () => {
  const gate = new PatentOutputGate({ ruleGate: makeRuleGate() });
  const msg = assistantMessage("该装置大约为 10 厘米。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, false, "warn 不挂起审批");
  const text = extractMessageText(result.message);
  assert.match(text, /合规提示/, "warn 应追加合规提示");
  assert.match(text, /EX-CLM-001/, "提示应含命中的规则 id");
});

test("干净文本 → 零违规、文本不变（防 structural 海量噪音回归）", () => {
  const gate = new PatentOutputGate({ ruleGate: makeRuleGate() });
  const clean = "本发明提供一种基于深度学习的图像分类方法，有效提高了分类准确率。";
  const result = gate.processMessage(assistantMessage(clean));
  assert.equal(result.needsApproval, false);
  assert.equal(extractMessageText(result.message), clean, "无违规时文本不应被污染");
});

test("空规则集 ruleGate → 降级放行（加载失败语义）", () => {
  const gate = new PatentOutputGate({ ruleGate: new RuleOutputGate({ rules: [] }) });
  const msg = assistantMessage("现有技术 CNXXXXXX 公开了一种方法。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, false);
  assert.equal(result.message, msg, "空规则集放行且不修改消息");
});

test("两段式串接：关键词审批词命中 + 规则门禁独立生效", () => {
  const pendings: Array<{ info: { approvalKeywordsHit: string[] }; ruleViolations?: unknown[] }> = [];
  const gate = new PatentOutputGate({
    ruleGate: makeRuleGate(),
    onPending: p => {
      pendings.push(p);
    },
  });
  // 关键词审批词「具备新颖性」命中（关键词门禁）+ 占位专利号命中（规则门禁）
  const msg = assistantMessage("专利结论：本方案具备新颖性，最接近的现有技术为 CNXXXXXX。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, true);
  gate.flushPending(result.pendingIndex!);
  assert.equal(pendings.length, 1);
  assert.ok(pendings[0].info.approvalKeywordsHit.length > 0, "关键词审批词命中");
  const violationIds = pendings[0].ruleViolations?.map(v => (v as { ruleId: string }).ruleId) ?? [];
  assert.ok(violationIds.includes("CON-COMP-0101"), "规则门禁命中占位专利号");
});
