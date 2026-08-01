import assert from "node:assert/strict";
import test from "node:test";
import { createDraftClaimsTool, draftClaims } from "../../../src/tool/builtin/draftClaims.js";

test("draft_claims generates an independent claim with essential features", () => {
  const result = draftClaims({
    invention_name: "一种自动化分拣装置",
    tech_domain: "mechanical",
    technical_features: ["壳体", "驱动单元", "分拣机构"],
    optional_features: ["传感器组件", "无线通信模块"],
  });
  assert.equal(result.claims.length, 3);
  assert.equal(result.claims[0].type, "independent");
  assert.match(result.claims[0].text, /一种自动化分拣装置/);
  assert.match(result.claims[0].text, /壳体；驱动单元；分拣机构。$/);
  assert.match(result.claims[0].text, /其特征在于/);
  // 从属权利要求梯度保护
  assert.equal(result.claims[1].type, "dependent");
  assert.equal(result.claims[1].refersTo, 1);
  assert.match(result.claims[1].text, /还包括：传感器组件。/);
  assert.equal(result.claims[2].refersTo, 2);
});

test("draft_claims auto-detects tech domain from features", () => {
  const chemical = draftClaims({
    invention_name: "一种催化剂组合物",
    technical_features: ["组分A", "组分B"],
  });
  assert.equal(chemical.tech_domain, "chemical");
  const software = draftClaims({
    invention_name: "一种数据处理方法",
    technical_features: ["接收数据", "解析数据", "输出结果"],
  });
  assert.equal(software.tech_domain, "software");
  assert.match(software.claims[0].text, /包括以下步骤：接收数据；解析数据；输出结果。/);
});

test("draft_claims formality checks flag vague terms and missing period", () => {
  const result = draftClaims({
    invention_name: "一种装置",
    tech_domain: "general",
    technical_features: ["壳体约10cm", "优选采用铝合金"],
  });
  const vague = result.violations.filter(v => v.rule === "clarity");
  assert.ok(vague.length > 0, "should flag vague terms");
  assert.ok(
    vague.some(v => v.message.includes("约")),
    "should flag 约",
  );
  assert.ok(
    vague.some(v => v.message.includes("优选")),
    "should flag 优选",
  );
  // 编号连续无错误
  const errors = result.violations.filter(v => v.severity === "error");
  assert.equal(errors.length, 0);
});

test("draft_claims flags illustration references in claims", () => {
  const result = draftClaims({
    invention_name: "一种装置",
    tech_domain: "mechanical",
    technical_features: ["壳体", "如图1所示的连接件"],
  });
  const noIll = result.violations.filter(v => v.rule === "no_illustration");
  assert.ok(noIll.length > 0, "should flag 如图…所示");
});

test("draft_claims tool definition is read-only", async () => {
  const tool = createDraftClaimsTool();
  assert.equal(tool.name, "draft_claims");
  assert.equal(tool.isReadOnly({ invention_name: "x", technical_features: [] }), true);
  const result = await tool.execute({ invention_name: "一种装置", technical_features: ["壳体"] }, {} as never);
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  assert.ok((first.value as { claims: unknown[] }).claims.length >= 1);
});
