import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecallPrompt,
  buildRefinedQuery,
  parseRecallDecision,
  RECALL_SCHEMA,
} from "../../../src/patent/search/recall.js";

test("buildRecallPrompt: 与创造性图原有提示词逐字一致", () => {
  const prompt = buildRecallPrompt({ parse: "特征A", priorArtText: "1. D1" });
  assert.equal(
    prompt,
    [
      "你是专利检索质量审查员。检查现有技术检索结果的覆盖度：",
      "- adequate：检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）",
      "- covered_features：已被检索结果覆盖的技术特征",
      "- missing_features：未被覆盖的关键技术特征（补检依据）",
      "【待评技术特征】",
      '<data>\n"特征A"\n</data>',
      "【检索结果摘要（含公开日）】",
      '<data>\n"1. D1"\n</data>',
      "",
      "请严格输出 JSON：{ adequate, covered_features, missing_features }。",
    ].join("\n"),
  );
});

test("buildRecallPrompt: 无检索结果时给出明确占位", () => {
  const prompt = buildRecallPrompt({ parse: "特征A", priorArtText: "" });
  assert.ok(prompt.includes("（无检索结果）"));
});

test("RECALL_SCHEMA: 三个字段均为必需", () => {
  assert.deepEqual(RECALL_SCHEMA.required, ["adequate", "covered_features", "missing_features"]);
});

test("parseRecallDecision: 合法 JSON 解析为结构化判断", () => {
  const decision = parseRecallDecision(
    JSON.stringify({ adequate: false, covered_features: ["A"], missing_features: ["B"] }),
  );
  assert.deepEqual(decision, { adequate: false, covered_features: ["A"], missing_features: ["B"] });
});

test("parseRecallDecision: 非 JSON 或缺 adequate 时返回 undefined", () => {
  assert.equal(parseRecallDecision("不是 JSON"), undefined);
  assert.equal(parseRecallDecision(JSON.stringify({ covered_features: [] })), undefined);
});

test("parseRecallDecision: 兼容代码围栏（与图内 recallRouter 同口径）", () => {
  const decision = parseRecallDecision(
    '```json\n{"adequate":true,"covered_features":["A"],"missing_features":[]}\n```',
  );
  assert.deepEqual(decision, { adequate: true, covered_features: ["A"], missing_features: [] });
});

test("buildRefinedQuery: 缺失特征拼成 OR 补检式", () => {
  assert.equal(buildRefinedQuery("壳体", ["滤芯", "活性炭"]), "壳体 OR 滤芯 OR 活性炭");
});

test("buildRefinedQuery: 无缺失特征时原样返回", () => {
  assert.equal(buildRefinedQuery("壳体", []), "壳体");
  assert.equal(buildRefinedQuery("", []), "补充检索");
});
