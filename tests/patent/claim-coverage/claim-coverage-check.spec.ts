import assert from "node:assert/strict";
import test from "node:test";
import { checkClaimEmbodimentCoverage } from "../../../src/patent/claim-coverage/coverage-check.js";
import type { ClaimCoverageEntry, ClaimEmbodimentCoverage } from "../../../src/patent/claim-coverage/types.js";

function entry(claimId: string, features: string[], embodimentRefs: string[]): ClaimCoverageEntry {
  return {
    claimId,
    features,
    embodimentRefs,
    coverage: embodimentRefs.length > 0 ? "full" : "none",
    uncoveredFeatures: embodimentRefs.length === 0 ? [...features] : [],
  };
}

function matrix(claims: ClaimCoverageEntry[]): ClaimEmbodimentCoverage {
  return { caseId: "case-test", claims, degraded: false };
}

test("空矩阵 → 三字段全空", () => {
  assert.deepEqual(checkClaimEmbodimentCoverage(matrix([])), {
    missingEmbodiment: [],
    badClaimIds: [],
    duplicateFeatures: [],
  });
});

test("全支撑：每权项有实施例引用 → 无缺口", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([
      entry("claim_1", ["特征A", "特征B"], ["embodiment_1", "embodiment_2"]),
      entry("claim_2", ["特征C"], ["embodiment_2"]),
      entry("claim_3", ["特征D"], ["embodiment_3"]),
    ]),
  );
  assert.deepEqual(result, { missingEmbodiment: [], badClaimIds: [], duplicateFeatures: [] });
});

test("无支撑：权项无任何实施例引用 → 全部特征列入 missingEmbodiment", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([entry("claim_1", ["特征A", "特征B"], []), entry("claim_2", ["特征C"], ["embodiment_1"])]),
  );
  assert.deepEqual(result.missingEmbodiment, [
    { claimId: "claim_1", feature: "特征A" },
    { claimId: "claim_1", feature: "特征B" },
  ]);
  assert.deepEqual(result.badClaimIds, []);
});

test("编号断裂：claim_1、claim_3 缺 claim_2 → badClaimIds 含缺失编号", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([entry("claim_1", ["特征A"], ["embodiment_1"]), entry("claim_3", ["特征C"], ["embodiment_3"])]),
  );
  assert.deepEqual(result.badClaimIds, ["claim_2"]);
});

test("编号格式非法：claim_x / claim_1a → badClaimIds 原样列出且不参与编号连续性", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([entry("claim_1", ["特征A"], ["embodiment_1"]), entry("claim_x", ["特征B"], ["embodiment_1"])]),
  );
  assert.deepEqual(result.badClaimIds, ["claim_x"]);
});

test("跨权项重复特征：同一特征出现在多个权项 → duplicateFeatures（提示性）", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([
      entry("claim_1", ["特征A", "特征B"], ["embodiment_1"]),
      entry("claim_2", ["特征B", "特征C"], ["embodiment_2"]),
    ]),
  );
  assert.deepEqual(result.duplicateFeatures, ["特征B"]);
  assert.deepEqual(result.missingEmbodiment, []);
});

test("特征归一化：空白串剔除、重复特征去重、首尾空白裁剪", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([entry("claim_1", [" 特征A ", "特征A", "   ", ""], ["embodiment_1"])]),
  );
  assert.deepEqual(result.missingEmbodiment, []);
  assert.deepEqual(result.badClaimIds, []);
});

test("无特征的权项不判缺口（特征列表为空）", () => {
  const result = checkClaimEmbodimentCoverage(matrix([entry("claim_1", [], [])]));
  assert.deepEqual(result, { missingEmbodiment: [], badClaimIds: [], duplicateFeatures: [] });
});

test("同时出现多类问题：无支撑 + 编号断裂 + 重复特征互不干扰", () => {
  const result = checkClaimEmbodimentCoverage(
    matrix([entry("claim_1", ["特征A", "特征X"], []), entry("claim_3", ["特征X"], ["embodiment_3"])]),
  );
  assert.deepEqual(result.missingEmbodiment, [
    { claimId: "claim_1", feature: "特征A" },
    { claimId: "claim_1", feature: "特征X" },
  ]);
  assert.deepEqual(result.badClaimIds, ["claim_2"]);
  assert.deepEqual(result.duplicateFeatures, ["特征X"]);
});

test("防 DoS（评审 C1）：超上界编号计入 badClaimIds 且不做 O(n) 扫描；非法编号不挂死", () => {
  // 1001 超上界 → 计 badClaimIds，不触发 1..1001 之外的循环
  const over = checkClaimEmbodimentCoverage(matrix([entry("claim_1001", ["特征A"], ["embodiment_1"])]));
  assert.deepEqual(over.badClaimIds, ["claim_1001"]);
  assert.deepEqual(over.missingEmbodiment, []);
  // 超大数字（Number 精度外的 400 位 9）→ Number 溢出 Infinity → 守卫后不挂死
  const huge = checkClaimEmbodimentCoverage(matrix([entry(`claim_${"9".repeat(400)}`, ["特征A"], ["embodiment_1"])]));
  assert.equal(huge.badClaimIds.length, 1);
  assert.deepEqual(huge.missingEmbodiment, []);
});
