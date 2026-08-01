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

test("draft_claims places prior_art in the preamble before 其特征在于", () => {
  const result = draftClaims({
    invention_name: "一种改进型阀门",
    tech_domain: "mechanical",
    technical_features: ["密封结构", "自清洁组件"],
    prior_art: "阀体、阀杆",
  });
  const independent = result.claims[0].text;
  // prior_art（共有特征）在前序部分，"其特征在于"之前
  assert.match(independent, /一种改进型阀门，包括：阀体、阀杆；其特征在于，还包括：密封结构；自清洁组件。/);
  const charIndex = independent.indexOf("其特征在于");
  const priorIndex = independent.indexOf("阀体");
  assert.ok(priorIndex >= 0 && priorIndex < charIndex, "prior_art must precede 其特征在于");
});

test("draft_claims chemical domain keeps 包含 terminology with prior_art", () => {
  const withPrior = draftClaims({
    invention_name: "一种催化剂组合物",
    tech_domain: "chemical",
    technical_features: ["活性组分", "载体"],
    prior_art: "溶剂",
  });
  const withoutPrior = draftClaims({
    invention_name: "一种催化剂组合物",
    tech_domain: "chemical",
    technical_features: ["活性组分", "载体"],
  });
  // 同一工具同一领域，术语必须一致（不因 prior_art 有无而切换 包括/包含）
  assert.match(withPrior.claims[0].text, /一种催化剂组合物，包含：溶剂；其特征在于，还包含：活性组分；载体。/);
  assert.match(withoutPrior.claims[0].text, /一种催化剂组合物，其特征在于，包含：活性组分；载体。/);
});

test("draft_claims software domain keeps prior_art in the preamble", () => {
  const result = draftClaims({
    invention_name: "一种数据处理方法",
    tech_domain: "software",
    technical_features: ["接收数据", "解析数据"],
    prior_art: "对原始数据进行采集",
  });
  const independent = result.claims[0].text;
  assert.match(
    independent,
    /一种数据处理方法的实现方法，包括以下步骤：对原始数据进行采集；其特征在于，还包括以下步骤：接收数据；解析数据。/,
  );
  const charIndex = independent.indexOf("其特征在于");
  assert.ok(independent.indexOf("对原始数据进行采集") < charIndex, "prior_art must precede 其特征在于 for software");
});

test("draft_claims normalizes trailing period in prior_art", () => {
  const result = draftClaims({
    invention_name: "一种改进型阀门",
    tech_domain: "mechanical",
    technical_features: ["密封结构"],
    prior_art: "阀体，包括密封圈。",
  });
  // 不得出现 "。；" 拼接
  assert.ok(!result.claims[0].text.includes("。；"), `claim must not contain 。；: ${result.claims[0].text}`);
  assert.match(result.claims[0].text, /包括：阀体，包括密封圈；其特征在于，还包括：密封结构。/);
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
