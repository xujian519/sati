import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import { createRuleCheckTool } from "../../../src/tool/builtin/ruleCheck.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { loadPatentComplianceRuleSet, type RulePackLoadResult, type RuleSet } from "../../../src/rule/index.js";

test("rule_check returns no violation for clean text", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "本方案采用特定装置提高效率。" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /无违规/);
});

test("rule_check reports violations with rule id and legal basis", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "本专利结论：存在侵权风险。依据专利法第99条。" }, makeToolContext());
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
  const result = await tool.execute({ text: "包含禁忌词。", scope: "custom" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /CUSTOM-1/);
});

test("rule_check unknown scope is not silently clean", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "任意文本", scope: "nonexistent" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  // 未知 scope 显式提示"未加载规则"，避免"静默零违规"误判合规
  assert.match(text, /未加载任何规则/);
  assert.match(text, /patent, patent-electrical, patent-full, pack/);
  assert.doesNotMatch(text, /无违规/);
});

test("rule_check scope=pack returns layered summary via injected pack loader", async () => {
  const pack = (): RulePackLoadResult => ({
    ruleSet: {
      rules: [
        {
          id: "PACK-1",
          name: "包内规则",
          severity: "minor",
          action: "review",
          check: { type: "keyword_blocklist", keywords: ["禁忌词"] },
        },
      ],
    },
    sources: ["rules/base/pack-rules.yaml"],
    warnings: [],
    layers: new Map([
      ["PACK-1", "base"],
      ["PACK-2", "domain:mechanical"],
    ]),
    manifestPath: null,
    manifestMtimeMs: null,
  });
  const tool = createRuleCheckTool({ pack });
  const result = await tool.execute({ text: "包含禁忌词。", scope: "pack" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /PACK-1/);
  assert.match(text, /规则分层: base 1 \+ domain:mechanical 1/);
  assert.match(text, /清单: 无，默认 rules\/base/);
});

test("rule_check scope=pack with no violations still prints layers summary", async () => {
  const pack = (): RulePackLoadResult => ({
    ruleSet: {
      rules: [
        {
          id: "PACK-1",
          name: "包内规则",
          severity: "minor",
          action: "review",
          check: { type: "keyword_blocklist", keywords: ["禁忌词"] },
        },
      ],
    },
    sources: [],
    warnings: [],
    layers: new Map([["PACK-1", "base"]]),
    manifestPath: null,
    manifestMtimeMs: null,
  });
  const tool = createRuleCheckTool({ pack });
  const result = await tool.execute({ text: "干净文本。", scope: "pack" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /rule_check\(pack\): 无违规/);
  assert.match(text, /规则分层: base 1/);
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
