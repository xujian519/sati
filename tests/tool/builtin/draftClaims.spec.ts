import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import { createDraftClaimsTool, draftClaims, normalizeInventionName } from "../../../src/tool/builtin/draftClaims.js";

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

test("draft_claims places structured shared_features in the preamble before 其特征在于", () => {
  const result = draftClaims({
    invention_name: "一种改进型阀门",
    tech_domain: "mechanical",
    technical_features: ["密封结构", "自清洁组件"],
    shared_features: ["阀体", "阀杆"],
  });
  const independent = result.claims[0].text;
  assert.match(independent, /一种改进型阀门，包括：阀体；阀杆；其特征在于，还包括：密封结构；自清洁组件。/);
  const charIndex = independent.indexOf("其特征在于");
  const sharedIndex = independent.indexOf("阀体");
  assert.ok(sharedIndex >= 0 && sharedIndex < charIndex, "shared_features must precede 其特征在于");
});

test("draft_claims rejects free-text prior_art as a claim feature (warning, not inserted)", () => {
  const result = draftClaims({
    invention_name: "一种改进型阀门",
    tech_domain: "mechanical",
    technical_features: ["密封结构"],
    prior_art: "传统阀门采用阀体与阀杆螺纹连接。",
  });
  const independent = result.claims[0].text;
  assert.ok(!independent.includes("传统阀门采用阀体"), `free-text prior_art must not become a feature: ${independent}`);
  assert.ok(
    result.warnings.some(w => w.includes("shared_features")),
    "should instruct callers to use shared_features",
  );
});

test("draft_claims chemical domain keeps 包含 terminology with shared_features", () => {
  const withShared = draftClaims({
    invention_name: "一种催化剂组合物",
    tech_domain: "chemical",
    technical_features: ["活性组分", "载体"],
    shared_features: ["溶剂"],
  });
  const withoutShared = draftClaims({
    invention_name: "一种催化剂组合物",
    tech_domain: "chemical",
    technical_features: ["活性组分", "载体"],
  });
  // 同一工具同一领域，术语必须一致（不因前序特征有无而切换 包括/包含）
  assert.match(withShared.claims[0].text, /一种催化剂组合物，包含：溶剂；其特征在于，还包含：活性组分；载体。/);
  assert.match(withoutShared.claims[0].text, /一种催化剂组合物，其特征在于，包含：活性组分；载体。/);
});

test("draft_claims software domain does not append 的实现方法 twice", () => {
  const result = draftClaims({
    invention_name: "一种数据处理方法",
    tech_domain: "software",
    technical_features: ["接收数据", "解析数据"],
    shared_features: ["对原始数据进行采集"],
  });
  const independent = result.claims[0].text;
  assert.match(
    independent,
    /一种数据处理方法，包括以下步骤：对原始数据进行采集；其特征在于，还包括以下步骤：接收数据；解析数据。/,
  );
  assert.ok(!independent.includes("的实现方法"), "name already ends with 方法");
  const charIndex = independent.indexOf("其特征在于");
  assert.ok(
    independent.indexOf("对原始数据进行采集") < charIndex,
    "shared features must precede 其特征在于 for software",
  );
});

test("draft_claims tool definition is read-only", async () => {
  const tool = createDraftClaimsTool();
  assert.equal(tool.name, "draft_claims");
  assert.equal(tool.isReadOnly({ invention_name: "x", technical_features: [] }), true);
  const result = await tool.execute({ invention_name: "一种装置", technical_features: ["壳体"] }, makeToolContext());
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  assert.ok((first.value as { claims: unknown[] }).claims.length >= 1);
});

test("normalizeInventionName strips repeated measure-word prefixes", () => {
  assert.equal(normalizeInventionName("一种相变储热装置"), "相变储热装置");
  assert.equal(normalizeInventionName("一件相变储热装置"), "相变储热装置");
  assert.equal(normalizeInventionName("一款相变储热装置"), "相变储热装置");
  assert.equal(normalizeInventionName("一项相变储热装置"), "相变储热装置");
  assert.equal(normalizeInventionName("一种一种相变储热装置"), "相变储热装置");
  assert.equal(normalizeInventionName(" 一种  相变储热装置 "), "相变储热装置");
  assert.equal(normalizeInventionName("相变储热装置"), "相变储热装置");
  assert.equal(normalizeInventionName("   "), "");
});

test("draft_claims never emits 一种一种 or a 一种-prefixed dependent reference", () => {
  const result = draftClaims({
    invention_name: "一种一种相变储热装置",
    tech_domain: "mechanical",
    technical_features: ["储热体", "换热管"],
    optional_features: ["保温层"],
  });
  assert.equal(result.invention_name, "相变储热装置");
  assert.ok(!result.claims[0].text.includes("一种一种"), result.claims[0].text);
  assert.match(result.claims[1].text, /根据权利要求1所述的相变储热装置，/);
  assert.ok(!result.claims[1].text.includes("所述的一种"), result.claims[1].text);
});
