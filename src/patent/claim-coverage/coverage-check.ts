/**
 * 覆盖矩阵确定性校验（纯函数，零依赖，供单测与 draft-spec 复用）。
 *
 * 判定规则（只信任 features + embodimentRefs 两列，不信任 LLM 推导的
 * coverage/uncoveredFeatures，避免自证）：
 *   - missingEmbodiment：权项无任何实施例引用（embodimentRefs 为空）→
 *     该权项全部特征列入（claim 级粒度；feature 级映射是 mapper 的扩展项）。
 *   - badClaimIds：claimId 非 "claim_<数字>" 格式，或 1..max 编号断裂。
 *   - duplicateFeatures：同一特征文本出现在 ≥2 个权项（提示性，不判失败）。
 */

import type { ClaimEmbodimentCoverage, CoverageCheckResult } from "./types.js";

/** claimId 格式：claim_<数字>（对齐矩阵骨架命名，与 claim-chart 的 "1a/1b" 规则不兼容）。 */
const CLAIM_ID_RE = /^claim_(\d+)$/;

/** 权利要求编号上界（防 DoS：超界编号直接计 badClaimIds，不做连续性扫描）。 */
const MAX_CLAIM_NO = 1000;

/** 特征文本归一化：去首尾空白；空串不参与判定。 */
function normalizeFeature(text: string): string {
  return text.trim();
}

export function checkClaimEmbodimentCoverage(matrix: ClaimEmbodimentCoverage): CoverageCheckResult {
  const missingEmbodiment: CoverageCheckResult["missingEmbodiment"] = [];
  const badClaimIds: string[] = [];
  const claimNumbers: number[] = [];
  const invalidClaimIds: string[] = [];
  const featureOwners = new Map<string, string[]>();

  for (const claim of matrix.claims) {
    const m = CLAIM_ID_RE.exec(claim.claimId);
    if (m === null) {
      badClaimIds.push(claim.claimId);
      continue;
    }
    const claimNo = Number(m[1]);
    // 评审 C1：限界 1..MAX_CLAIM_NO——超界/非有限编号计 badClaimIds 且不参与连续性扫描
    // （LLM 单条输出如 "claim_" + 大数字不得触发 O(n) 循环挂死进程）。
    if (!Number.isInteger(claimNo) || claimNo < 1 || claimNo > MAX_CLAIM_NO) {
      invalidClaimIds.push(claim.claimId);
      continue;
    }
    claimNumbers.push(claimNo);

    // 特征去重 + 去空白，保持判定确定性
    const features = [...new Set(claim.features.map(normalizeFeature).filter(f => f.length > 0))];
    if (features.length === 0) continue;

    // 权项无任何实施例引用 → 全部特征无支撑（claim 级粒度）
    if (claim.embodimentRefs.length === 0) {
      for (const feature of features) {
        missingEmbodiment.push({ claimId: claim.claimId, feature });
      }
    }

    for (const feature of features) {
      const owners = featureOwners.get(feature) ?? [];
      owners.push(claim.claimId);
      featureOwners.set(feature, owners);
    }
  }

  // 编号连续性：仅对界内编号（1..MAX_CLAIM_NO）做 1..max 缺号扫描（与 claim-chart
  // element-validator 的"跳号"思想一致）；非法/超界编号已在上方计 badClaimIds。
  if (claimNumbers.length > 0) {
    const max = Math.max(...claimNumbers);
    const present = new Set(claimNumbers);
    for (let n = 1; n <= max; n += 1) {
      if (!present.has(n)) badClaimIds.push(`claim_${n}`);
    }
  }
  badClaimIds.push(...invalidClaimIds);

  // 跨权项重复特征（提示性）
  const duplicateFeatures: string[] = [];
  for (const [feature, owners] of featureOwners) {
    if (owners.length > 1) duplicateFeatures.push(feature);
  }

  return { missingEmbodiment, badClaimIds, duplicateFeatures };
}
