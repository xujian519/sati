/**
 * 论证三向指针（#739）：三套结构各自映射到 ArgumentRef、统一缺口去重。
 *
 * 存储格式不变：claim-chart / syllogism / claim-binding 的既有字段保持原样，
 * 只新增可选 ref 与统一缺口。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ArgumentRefError,
  ClaimBinding,
  EvidenceEngine,
  FactBlackboard,
  SyllogismError,
  argumentRefKey,
  assertArgumentRef,
  claimChartGapsToArgumentGaps,
  claimBindingRef,
  dedupeArgumentGaps,
  detectGaps,
  normalizeArgumentRef,
  ruleAssertion,
  syllogismErrorToArgumentGap,
  syllogismRef,
  unbackedClaimsToArgumentGaps,
  type ArgumentGap,
  type Syllogism,
} from "../../../src/patent/index.js";
import type { ChartRow, ChartTarget, ClaimElement } from "../../../src/patent/claim-chart/protocol/types.js";
import { createEvaluateEvidenceTool } from "../../../src/tool/builtin/evaluateEvidence.js";
import { makeToolContext } from "../../tool/context-fixture.js";

const ELEMENT: ClaimElement = { id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" };
const TARGET: ChartTarget = { id: "D1", kind: "prior-art" };

function gapRow(elementId: string, targetId: string, mapping: ChartRow["mapping"]): ChartRow {
  return { elementId, targetId, quote: "", pinCite: "", mapping, state: mapping, verified: false };
}

function makeBlackboard(): FactBlackboard {
  let clock = 0;
  const now = () => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}Z`;
  const bb = new FactBlackboard({ caseId: "case-1", caseType: "invalidation", technicalField: "机械", now });
  bb.addFact({
    id: "F1",
    source: "user_text",
    content: "权利要求1的区别特征是压缩弹簧",
    confidence: 0.9,
    extractedAt: now(),
    category: "technical",
  });
  bb.addRuleConstraint({
    articleId: "A22.3",
    articleName: "专利法第22条第3款",
    requirement: "must",
    description: "创造性：非显而易见",
  });
  return bb;
}

function syllogism(overrides: Partial<Syllogism> = {}): Syllogism {
  return {
    id: "S1",
    majorPremise: { label: "专利法第22条第3款", source: "statute", refId: "A22.3", content: "非显而易见" },
    minorPremise: { label: "区别特征", source: "case_fact", refId: "F1", content: "压缩弹簧" },
    conclusion: "权利要求1具备创造性",
    factRef: "F1",
    articleRef: "A22.3",
    confidence: 0.8,
    validated: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 不变量与规范化
// ---------------------------------------------------------------------------

test("assertArgumentRef：空引用 fail-loud，空白字段被丢弃，其余字段保留", () => {
  assert.throws(() => assertArgumentRef({}), ArgumentRefError);
  assert.throws(() => assertArgumentRef({ elementId: "   ", factRef: "" }), /至少需要一个非空字段/);
  assert.deepEqual(assertArgumentRef({ elementId: " 1a ", factRef: "", articleRef: " A22.3 " }), {
    elementId: "1a",
    articleRef: "A22.3",
  });
  assert.equal(normalizeArgumentRef({ elementId: "" }), undefined);
});

test("argumentRefKey：字段按 elementId/factRef/articleRef 固定顺序，键与对象键顺序无关", () => {
  assert.equal(
    argumentRefKey({ factRef: "F1", articleRef: "A22.3" }),
    argumentRefKey({ articleRef: "A22.3", factRef: "F1" }),
  );
  assert.notEqual(argumentRefKey({ elementId: "1a" }), argumentRefKey({ factRef: "1a" }));
});

// ---------------------------------------------------------------------------
// 三套结构各自映射
// ---------------------------------------------------------------------------

test("claim-chart：缺口带 elementId 指针，适配层产出统一缺口", () => {
  const gaps = detectGaps([gapRow("1a", "D1", "not-found")], [ELEMENT], [TARGET]);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0]!.ref, { elementId: "1a" });

  const unified = claimChartGapsToArgumentGaps(gaps);
  assert.deepEqual(unified, [
    {
      ref: { elementId: "1a" },
      kind: "not-found",
      detail: gaps[0]!.reason,
      source: "claim-chart",
    },
  ]);
});

test("syllogism：syllogismRef 映射事实+法条；校验失败的错误带可追溯指针", () => {
  assert.deepEqual(syllogismRef(syllogism()), { factRef: "F1", articleRef: "A22.3" });

  const bb = makeBlackboard();
  assert.throws(
    () => ruleAssertion(bb, syllogism({ factRef: "F404" })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /F404/);
      assert.deepEqual((error as { ref?: unknown }).ref, { factRef: "F404" });
      return true;
    },
  );
  assert.throws(
    () => ruleAssertion(bb, syllogism({ articleRef: "A99.9" })),
    (error: unknown) => {
      assert.deepEqual((error as { ref?: unknown }).ref, { articleRef: "A99.9" });
      return true;
    },
  );

  const unified = syllogismErrorToArgumentGap(new SyllogismError("缺引用"));
  assert.equal(unified, undefined, "无引用时不得伪造指针");
});

test("claim-binding：无证据结论映射到 factRef；有证据结论不产出缺口", () => {
  const binding = new ClaimBinding();
  binding.bind("C1", "span-1");
  const unbacked = binding.unbackedClaimRefs(["C1", "C2"]);
  assert.deepEqual(unbacked, [{ claimId: "C2", ref: { factRef: "C2" } }]);
  assert.deepEqual(binding.unbackedClaims(["C1", "C2"]), ["C2"], "既有字符串形态保留");

  const unified = unbackedClaimsToArgumentGaps(unbacked);
  assert.equal(unified.length, 1);
  assert.deepEqual(unified[0]!.ref, { factRef: "C2" });
  assert.equal(unified[0]!.kind, "unbacked-claim");
  assert.equal(unified[0]!.source, "claim-binding");
  assert.deepEqual(claimBindingRef("C3"), { factRef: "C3" });
});

// ---------------------------------------------------------------------------
// 统一去重
// ---------------------------------------------------------------------------

test("dedupeArgumentGaps：同一 ref+kind 跨来源只计一次并合并 sources", () => {
  const ref = { factRef: "F1" };
  const gaps: ArgumentGap[] = [
    { ref, kind: "missing-evidence", detail: "claim-chart 报出", source: "claim-chart" },
    { ref, kind: "missing-evidence", detail: "syllogism 报出", source: "syllogism" },
    { ref: { factRef: "F2" }, kind: "missing-evidence", detail: "另一事实", source: "syllogism" },
    { ref, kind: "other-kind", detail: "不同 kind", source: "claim-binding" },
  ];
  const deduped = dedupeArgumentGaps(gaps);
  assert.equal(deduped.length, 3, "同 ref+kind 合并；不同 ref 或 kind 保留");
  assert.deepEqual(deduped[0]!.sources, ["claim-chart", "syllogism"]);
  assert.equal(deduped[0]!.source, "claim-chart", "source 保留首条");
  assert.equal(deduped[0]!.detail, "claim-chart 报出", "detail 保留首条");
  assert.deepEqual(deduped[1]!.sources, ["syllogism"]);
  assert.deepEqual(deduped[2]!.sources, ["claim-binding"]);
});

test("dedupeArgumentGaps：空 ref fail-loud（不把无指针缺口混进合并表）", () => {
  assert.throws(
    () => dedupeArgumentGaps([{ ref: {}, kind: "x", detail: "d", source: "claim-chart" }]),
    ArgumentRefError,
  );
});

// ---------------------------------------------------------------------------
// 消费方：evaluate_evidence 输出接 ref（既有字段不变）
// ---------------------------------------------------------------------------

test("evaluate_evidence：输入 claimRefs 映射为输出的统一指针", async () => {
  const tool = createEvaluateEvidenceTool({ engine: new EvidenceEngine() });
  const res = await tool.execute(
    { snippet: "对比文件 1 公开了双层真空结构", claimRefs: ["C1", "C2"] },
    makeToolContext(),
  );
  const data = res.data as { claimRefs?: Array<{ claimId: string; ref: unknown }> };
  assert.deepEqual(data.claimRefs, [
    { claimId: "C1", ref: { factRef: "C1" } },
    { claimId: "C2", ref: { factRef: "C2" } },
  ]);

  const withoutRefs = await tool.execute({ snippet: "无结论绑定" }, makeToolContext());
  assert.equal((withoutRefs.data as { claimRefs?: unknown }).claimRefs, undefined, "未提供结论时不新增字段");
});
