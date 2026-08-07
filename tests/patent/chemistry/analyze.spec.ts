/**
 * src/patent/chemistry — 识别核心逻辑测试（防幻觉三重闭环）。
 *
 * 覆盖：图片两步法多候选选优、全部候选非法 → needHumanReview、名称转换单步流、
 * 文本三级流水线（LLM 复核 + 名称转换）、纯分子式文本直出。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import {
  analyzeChemicalImage,
  analyzeChemicalName,
  analyzeChemicalText,
  type ChemistryModelClient,
  type ChemistryPhase,
} from "../../../src/patent/chemistry/index.js";
import type { ChemicalStructureResult } from "../../../src/patent/chemistry/types.js";

const STEP1_JSON = JSON.stringify({
  is_chemical: true,
  kind: "structure",
  overall_description: "阿司匹林（乙酰水杨酸）的结构式",
  confidence: 0.9,
  notes: [],
});

const STEP2_JSON = JSON.stringify({
  kind: "structure",
  candidates: [
    { smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", confidence: 0.95 },
    { smiles: "CC(=O)OC1=CC=CC=C1", confidence: 0.6 },
  ],
  names: ["阿司匹林", "乙酰水杨酸"],
  formula: "C9H8O4",
  warnings: [],
});

const NAME_JSON = JSON.stringify({
  kind: "structure",
  candidates: [{ smiles: "C1=CC=CC=C1", confidence: 0.8 }],
  names: ["苯"],
  formula: "C6H6",
});

const REVIEW_JSON = JSON.stringify({
  kind: "structure",
  kept_formulas: ["C9H8O4"],
  kept_smiles: [],
  names: [{ name: "阿司匹林", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", confidence: 0.9 }],
  warnings: [],
});

/** 构造 fake 模型客户端：按 request.metadata.phase 判别返回对应 JSON。 */
function fakeModel(
  responder: (phase: ChemistryPhase) => string,
): ChemistryModelClient & { requests: CanonicalModelRequest[] } {
  const requests: CanonicalModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      const phase = request.metadata?.phase as ChemistryPhase;
      yield { type: "text_delta", text: responder(phase) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
}

const BASE_IMAGE = {
  imagePath: "chem1.png",
  imageBase64: "aGVsbG8=",
  imageMimeType: "image/png",
  imageBytes: 5,
};

test("analyze: 图片两步法——多候选校验取合法候选中置信度最高者", async () => {
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : STEP2_JSON));
  const result = await analyzeChemicalImage(BASE_IMAGE, model);

  assert.equal(result.kind, "structure");
  assert.equal(result.chosenIndex, 0);
  assert.equal(result.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
  assert.equal(result.formula, "C9H8O4");
  assert.equal(result.names[0], "阿司匹林");
  assert.equal(result.usable, true);
  assert.equal(result.needHumanReview, false);
  assert.equal(result.modelUsed, "moonshot/kimi-k3");
  assert.deepEqual(
    model.requests.map(r => r.metadata?.phase),
    ["step1", "step2"],
  );
});

test("analyze: 图片两步法——全部候选非法 → needHumanReview（防幻觉 H1）", async () => {
  const invalidStep2 = JSON.stringify({
    kind: "structure",
    candidates: [
      { smiles: "!!!invalid!!!", confidence: 0.9 },
      { smiles: "###", confidence: 0.5 },
    ],
    names: [],
  });
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : invalidStep2));
  const result = await analyzeChemicalImage(BASE_IMAGE, model);

  assert.equal(result.usable, false);
  assert.equal(result.needHumanReview, true);
  assert.equal(result.chosenIndex, -1);
  assert.ok(
    result.warnings.some(w => w.includes("未通过校验")),
    "应给出校验失败 warning",
  );
});

test("analyze: 名称转换单步流（H2 选 a）", async () => {
  const model = fakeModel(() => NAME_JSON);
  const result = await analyzeChemicalName("苯", model);

  assert.equal(result.usable, true);
  assert.equal(result.canonicalSmiles, "c1ccccc1");
  assert.equal(result.formula, "C6H6");
  assert.ok(result.names.includes("苯"));
  assert.deepEqual(
    model.requests.map(r => r.metadata?.phase),
    ["name"],
  );
});

test("analyze: 文本三级流水线——LLM 复核 + 名称转换 + RDKit 校验", async () => {
  const model = fakeModel(() => REVIEW_JSON);
  const result = await analyzeChemicalText("本实施例制备了阿司匹林 CC(=O)OC1=CC=CC=C1C(=O)O，分子式 C9H8O4。", model);

  assert.equal(result.usable, true);
  assert.equal(result.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
  assert.ok(result.names.includes("阿司匹林"));
  assert.equal(result.formula, "C9H8O4");
  assert.deepEqual(
    model.requests.map(r => r.metadata?.phase),
    ["review"],
  );
});

test("analyze: 文本复核失败时降级为仅正则候选并标记人工复核", async () => {
  const model = fakeModel(() => "not json at all");
  const result = await analyzeChemicalText("化合物为 CC(=O)Oc1ccccc1C(=O)O。", model);

  assert.equal(result.needHumanReview, true);
  assert.equal(result.usable, false);
  assert.ok(
    result.warnings.some(w => w.includes("降级")),
    "应注明降级原因",
  );
});

test("analyze: 图片非化学图示时 Step2 仍执行但保留判定 warning", async () => {
  const notChemical = JSON.stringify({
    is_chemical: false,
    kind: null,
    overall_description: "机械装置结构图",
    confidence: 0.85,
  });
  const model = fakeModel(phase => (phase === "step1" ? notChemical : STEP2_JSON));
  const result = await analyzeChemicalImage(BASE_IMAGE, model);

  assert.ok(
    result.warnings.some(w => w.includes("非化学图示")),
    "应提示图片非化学图示",
  );
  assert.equal(result.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
});

test("analyze: 分子式图（无 SMILES 候选）直接采用公式字段", async () => {
  const formulaStep2 = JSON.stringify({
    kind: "formula",
    candidates: [],
    names: ["葡萄糖"],
    formula: "C6H12O6",
  });
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : formulaStep2));
  const result: ChemicalStructureResult = await analyzeChemicalImage(BASE_IMAGE, model);

  assert.equal(result.kind, "formula");
  assert.equal(result.formula, "C6H12O6");
  assert.equal(result.usable, true);
  assert.equal(result.needHumanReview, false);
});

test("analyze: 评审 M1——逆序候选选置信度最高的合法者（非首个合法者）", async () => {
  const reversedStep2 = JSON.stringify({
    kind: "structure",
    candidates: [
      { smiles: "C1=CC=CC=C1", confidence: 0.62 },
      { smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", confidence: 0.95 },
    ],
    names: [],
  });
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : reversedStep2));
  const result = await analyzeChemicalImage(BASE_IMAGE, model);

  assert.equal(result.chosenIndex, 1, "应选中后输出的高置信候选");
  assert.equal(result.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
  assert.equal(result.confidence, 0.95);
  assert.equal(result.usable, true);
});

test("analyze: 评审 H1——图片公式分支垃圾分子式不得直通 usable", async () => {
  const garbageStep2 = JSON.stringify({
    kind: "formula",
    candidates: [],
    names: [],
    formula: "ABC!@#",
  });
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : garbageStep2));
  const result = await analyzeChemicalImage(BASE_IMAGE, model);

  assert.equal(result.usable, false);
  assert.equal(result.needHumanReview, true);
  assert.equal(result.formula, undefined, "非法公式不得回显");
  assert.ok(
    result.warnings.some(w => w.includes("Hill")),
    "应注明公式校验失败",
  );
});

test("analyze: 评审 H1——文本复核分支垃圾分子式进入人工复核", async () => {
  const garbageReview = JSON.stringify({
    kind: "formula",
    kept_formulas: ["XYZ123!"],
    kept_smiles: [],
    names: [],
    warnings: [],
  });
  const model = fakeModel(() => garbageReview);
  const result = await analyzeChemicalText("其分子式为 XYZ123!。", model);

  assert.equal(result.usable, false);
  assert.equal(result.needHumanReview, true);
  assert.equal(result.formula, undefined);
});

test("analyze: 评审 M6——仅 kept_smiles 召回的候选置信度低于门槛 → 人工复核", async () => {
  const keptOnly = JSON.stringify({
    kind: "structure",
    kept_formulas: [],
    kept_smiles: ["CC(=O)Oc1ccccc1C(=O)O"],
    names: [],
    warnings: [],
  });
  const model = fakeModel(() => keptOnly);
  const result = await analyzeChemicalText("化合物为 CC(=O)Oc1ccccc1C(=O)O。", model);

  assert.equal(result.candidates[0]?.valid, true, "候选本身应通过 RDKit 校验");
  assert.equal(result.usable, false, "正则召回候选不得压线直通");
  assert.equal(result.needHumanReview, true);
});

test("analyze: 评审 M2——取消后不重试，直接降级返回", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model: ChemistryModelClient = {
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "部分输出" };
      controller.abort();
      throw new Error("aborted");
    },
  };
  const result = await analyzeChemicalName("苯", model, { signal: controller.signal });

  assert.equal(calls, 1, "取消不应触发重试");
  assert.equal(result.usable, false);
  assert.ok(result.warnings.some(w => w.includes("取消")));
});
