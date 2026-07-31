import assert from "node:assert/strict";
import test from "node:test";
import { RuleOutputGate, type ConstitutionalRule, type RuleSet } from "../../src/rule/index.js";

function ruleSet(rules: ConstitutionalRule[]): RuleSet {
  return { rules };
}

test("RuleOutputGate appends warning text for warn rules without approval", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "PAT-RISK-001",
        name: "风险提示",
        severity: "major",
        action: "warn",
        legalBasis: "执业规范",
        check: { type: "keyword_blocklist", keywords: ["侵权"] },
      },
    ]),
  );
  const result = gate.process("本方案不构成侵权。");
  assert.equal(result.needsApproval, false);
  assert.ok(result.warnHits.includes("PAT-RISK-001"));
  assert.match(result.text, /合规提示/);
  assert.match(result.text, /PAT-RISK-001/);
  assert.match(result.text, /依据：执业规范/);
});

test("RuleOutputGate marks review violations as needsApproval", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "PAT-APPROVAL-001",
        name: "人工审批",
        severity: "critical",
        action: "review",
        check: { type: "keyword_blocklist", keywords: ["专利结论"] },
      },
    ]),
  );
  const result = gate.process("专利结论：方案具备新颖性。");
  assert.equal(result.needsApproval, true);
  assert.ok(result.reviewHits.includes("PAT-APPROVAL-001"));
});

test("RuleOutputGate treats block violations as needsApproval with block banner", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "CON-102",
        name: "强制拦截",
        severity: "critical",
        action: "block",
        check: { type: "keyword_blocklist", keywords: ["赌博"] },
      },
    ]),
  );
  const result = gate.process("该装置用于赌博检测。");
  assert.equal(result.needsApproval, true);
  assert.ok(result.blockHits.includes("CON-102"));
  assert.match(result.text, /🚫/);
});

test("RuleOutputGate keeps log violations out of text but records them", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "CON-LOG",
        name: "记录",
        severity: "minor",
        action: "log",
        check: { type: "keyword_blocklist", keywords: ["实施例"] },
      },
    ]),
  );
  const result = gate.process("包含实施例的说明。");
  assert.equal(result.needsApproval, false);
  assert.equal(result.text, "包含实施例的说明。");
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.action, "log");
});

test("RuleOutputGate escapes XML-special characters in violations", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "CON-X",
        name: "转义测试",
        severity: "major",
        action: "warn",
        legalBasis: "依据<审查指南>&细则",
        check: { type: "keyword_blocklist", keywords: ["<script>"] },
      },
    ]),
  );
  const result = gate.process("包含 <script>alert(1)</script> 的文本。");
  // 追加的合规提示块中：证据与依据被转义（原文保留）
  const hint = result.text.slice(result.text.indexOf("合规提示"));
  assert.match(hint, /&lt;script&gt;/);
  assert.match(hint, /依据&lt;审查指南&gt;&amp;细则/);
});

test("RuleOutputGate escapes warnTitle and blockMessage", () => {
  const ruleSetWarn = ruleSet([
    {
      id: "W1",
      name: "x",
      severity: "minor",
      action: "warn",
      check: { type: "keyword_blocklist", keywords: ["注意"] },
    },
  ]);
  const warnResult = new RuleOutputGate(ruleSetWarn, { warnTitle: "提示<注入>" }).process("含注意内容。");
  assert.match(warnResult.text, /提示&lt;注入&gt;/);

  const ruleSetBlock = ruleSet([
    {
      id: "R1",
      name: "x",
      severity: "critical",
      action: "block",
      check: { type: "keyword_blocklist", keywords: ["禁止"] },
    },
  ]);
  const blockResult = new RuleOutputGate(ruleSetBlock, { blockMessage: "拦截 & 审批" }).process("含禁止内容。");
  assert.match(blockResult.text, /拦截 &amp; 审批/);
});

test("RuleOutputGate returns text unchanged when no violations", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "R1",
        name: "无命中",
        severity: "major",
        action: "block",
        check: { type: "keyword_blocklist", keywords: ["绝不出现"] },
      },
    ]),
  );
  const result = gate.process("正常输出。");
  assert.equal(result.text, "正常输出。");
  assert.equal(result.needsApproval, false);
  assert.equal(result.violations.length, 0);
});

test("RuleOutputGate combines warn and review violations", () => {
  const gate = new RuleOutputGate(
    ruleSet([
      {
        id: "W1",
        name: "warn 规则",
        severity: "minor",
        action: "warn",
        check: { type: "keyword_blocklist", keywords: ["绝对"] },
      },
      {
        id: "R1",
        name: "review 规则",
        severity: "critical",
        action: "review",
        check: { type: "keyword_blocklist", keywords: ["最终建议"] },
      },
    ]),
  );
  const result = gate.process("绝对可靠的最终建议。");
  assert.equal(result.needsApproval, true);
  assert.ok(result.warnHits.includes("W1"));
  assert.ok(result.reviewHits.includes("R1"));
  assert.match(result.text, /合规提示/);
});
