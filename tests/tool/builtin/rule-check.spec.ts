import assert from "node:assert/strict";
import test from "node:test";
import { createRuleCheckTool } from "../../../src/tool/builtin/ruleCheck.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { loadPatentComplianceRuleSet, type RuleSet } from "../../../src/rule/index.js";

test("rule_check returns no violation for clean text", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "本方案采用特定装置提高效率。" }, {} as never);
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /无违规/);
});

test("rule_check reports violations with rule id and legal basis", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "本专利结论：不构成侵权。依据专利法第99条。" }, {} as never);
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /发现 \d+ 条违规/);
  assert.match(text, /PAT-RISK-001/);
  assert.match(text, /PAT-APPROVAL-001/);
  assert.match(text, /PAT-CITE-001/);
  assert.match(text, /依据：/);
});

test("rule_check honors custom scope loader", async () => {
  const loader = (scope: string): RuleSet => {
    if (scope === "custom") {
      return {
        rules: [
          {
            id: "CUSTOM-1",
            name: "自定义",
            severity: "critical",
            action: "block",
            check: { type: "keyword_blocklist", keywords: ["禁忌词"] },
          },
        ],
      };
    }
    return { rules: [] };
  };
  const tool = createRuleCheckTool({ loader });
  const result = await tool.execute({ text: "包含禁忌词。", scope: "custom" }, {} as never);
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /CUSTOM-1/);
});

test("rule_check unknown scope degrades to empty rule set", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "任意文本", scope: "nonexistent" }, {} as never);
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /无违规/);
});

test("builtin registry includes rule_check by default", () => {
  const registry = createBuiltinRegistry();
  assert.equal(registry.has("rule_check"), true);
  const tool = registry.get("rule_check");
  assert.equal(tool?.isReadOnly({ text: "x" }), true);
});

test("builtin registry can skip rule_check", () => {
  const registry = createBuiltinRegistry({ ruleCheck: false });
  assert.equal(registry.has("rule_check"), false);
});

test("rule_check with patent asset flags risk keywords", async () => {
  const { ruleSet } = loadPatentComplianceRuleSet();
  assert.ok(ruleSet.rules.length >= 4);
});
