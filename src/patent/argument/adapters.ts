/**
 * 三套论证结构 → 统一缺口（ArgumentGap）的适配层。
 *
 * 只做「读取既有结构 + 映射」，不替换任何存储格式：claim-chart 仍是要素网格、
 * syllogism 仍是三段论、claim-binding 仍是结论↔证据映射。三者的共同出口是
 * `ArgumentRef`，因此缺口可以在同一张表里合并、去重、按「要素/事实/法条」追溯。
 */

import { claimChartGapRef } from "../claim-chart/runtime/gap-detector.js";
import type { GapEntry } from "../claim-chart/protocol/types.js";
import type { UnbackedClaim } from "../evidence/claimBinding.js";
import type { SyllogismError } from "../reasoning/syllogism.js";
import type { ArgumentGap } from "./types.js";

/** claim-chart 缺口 → 统一缺口（kind 取 mapping 桶：not-found / needs-evidence / partial / unevaluated）。 */
export function claimChartGapsToArgumentGaps(gaps: readonly GapEntry[]): ArgumentGap[] {
  return gaps.map(gap => ({
    ref: claimChartGapRef(gap),
    kind: gap.mapping,
    detail: gap.reason,
    source: "claim-chart",
  }));
}

/**
 * 三段论校验失败 → 统一缺口。错误没带引用（事实与法条都为空）时返回 undefined：
 * 没有可追溯对象，不能伪造一个指针。
 */
export function syllogismErrorToArgumentGap(
  error: SyllogismError,
  kind = "invalid-syllogism",
): ArgumentGap | undefined {
  if (error.ref === undefined) return undefined;
  return { ref: error.ref, kind, detail: error.message, source: "syllogism" };
}

/** 无证据结论 → 统一缺口（引用 `factRef: claimId`）。 */
export function unbackedClaimsToArgumentGaps(claims: readonly UnbackedClaim[]): ArgumentGap[] {
  const gaps: ArgumentGap[] = [];
  for (const claim of claims) {
    if (claim.ref === undefined) continue;
    gaps.push({
      ref: claim.ref,
      kind: "unbacked-claim",
      detail: `结论 ${claim.claimId} 缺少证据支持`,
      source: "claim-binding",
    });
  }
  return gaps;
}
