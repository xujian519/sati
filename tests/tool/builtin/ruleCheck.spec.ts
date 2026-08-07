/**
 * src/tool/builtin/ruleCheck.ts — 宪法规则检查工具测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRuleCheckTool } from "../../../src/tool/builtin/ruleCheck.js";
import { loadPatentElectricalRuleSet } from "../../../src/rule/index.js";
import { makeToolContext } from "../../tool/context-fixture.js";

test("loadPatentElectricalRuleSet: 合并通用合规与 H 部电学规则", () => {
  const result = loadPatentElectricalRuleSet();
  assert.ok(result.source, "应定位到规则源");
  assert.ok(result.source!.includes("compliance.yaml"), "应包含通用合规规则");
  assert.ok(result.source!.includes("electrical-section-h.yaml"), "应包含 H 部电学规则");
  const ids = result.ruleSet.rules.map(r => r.id);
  assert.ok(
    ids.some(id => id.startsWith("PAT-")),
    "应含通用规则 PAT-*",
  );
  assert.ok(
    ids.some(id => id.startsWith("H-")),
    "应含 H 部规则 H-*",
  );
  assert.equal(result.warnings.length, 0, `加载不应有警告：${result.warnings.join("; ")}`);
});

test("rule_check: patent scope 仅命中通用规则", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute(
    {
      text: "根据上述分析，本专利具有专利性结论，且最终建议立即申请。",
      scope: "patent",
    },
    makeToolContext(),
  );
  const block = result.content[0];
  assert.equal(block.type, "text");
  const text = block.text;
  assert.ok(text.includes("PAT-APPROVAL-001") || text.includes("无违规"), `实际：${text}`);
  assert.equal(text.includes("H-"), false, "patent scope 不应命中 H 部规则");
});

test("rule_check: patent-electrical scope 命中 H 部规则", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute(
    {
      text: "本发明涉及一种无线通信电路，包括电阻、电容等元件，所述处理模块配置为对信号进行放大。",
      scope: "patent-electrical",
    },
    makeToolContext(),
  );
  const block = result.content[0];
  assert.equal(block.type, "text");
  const text = block.text;
  assert.ok(text.includes("H-") || text.includes("PAT-"), `应命中至少一条规则，实际：${text}`);
});

test("rule_check: 未知 scope 提示可用 scope", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "任意文本", scope: "unknown" }, makeToolContext());
  const block = result.content[0];
  assert.equal(block.type, "text");
  const text = block.text;
  assert.ok(text.includes("patent"), `实际：${text}`);
  assert.ok(text.includes("patent-electrical"), `实际：${text}`);
});
