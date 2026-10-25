/**
 * ClaimBinding 结论-证据绑定（移植自 Mady agentcore/evidence/claim_binding.go 设计）。
 *
 * 维护 claim（结论 id）→ EvidenceSpan（证据 id）多对多映射：
 *   - bind(claimId, spanId)：把证据挂接到结论
 *   - unbackedClaims()：列出**没有任何证据支持**的结论 —— 专业结论的
 *     "无证据支持"显式标记，而非当作事实陈述
 *   - spansForClaim(claimId)：给定结论的全部证据（冲突检测的输入）
 */

import { assertArgumentRef } from "../argument/refs.js";
import type { ArgumentRef } from "../argument/types.js";

/** 无证据支持的结论及其统一论证指针。 */
export type UnbackedClaim = {
  claimId: string;
  /** 三向指针中没有独立的 claim 字段：结论 id 在推理黑板上就是事实引用。 */
  ref?: ArgumentRef;
};

/** 结论 id → 统一论证指针（`factRef: claimId`）。 */
export function claimBindingRef(claimId: string): ArgumentRef {
  return assertArgumentRef({ factRef: claimId }, `结论 ${claimId}`);
}

export class ClaimBinding {
  private readonly claimToSpans = new Map<string, Set<string>>();
  private readonly spanToClaims = new Map<string, Set<string>>();

  /** 绑定一个证据到结论（幂等）。 */
  bind(claimId: string, spanId: string): void {
    let spans = this.claimToSpans.get(claimId);
    if (!spans) {
      spans = new Set();
      this.claimToSpans.set(claimId, spans);
    }
    spans.add(spanId);

    let claims = this.spanToClaims.get(spanId);
    if (!claims) {
      claims = new Set();
      this.spanToClaims.set(spanId, claims);
    }
    claims.add(claimId);
  }

  /** 解绑（重规划/纠错时用）。 */
  unbind(claimId: string, spanId: string): void {
    this.claimToSpans.get(claimId)?.delete(spanId);
    this.spanToClaims.get(spanId)?.delete(claimId);
  }

  /** 给定结论的全部证据 id（无则空数组）。 */
  spansForClaim(claimId: string): string[] {
    return [...(this.claimToSpans.get(claimId) ?? [])];
  }

  /** 给定证据支持的结论 id。 */
  claimsForSpan(spanId: string): string[] {
    return [...(this.spanToClaims.get(spanId) ?? [])];
  }

  /**
   * 列出无证据支持的结论：claimIds 为全部已登记结论，
   * 返回其中没有任何绑定证据的部分。
   */
  unbackedClaims(claimIds: Iterable<string>): string[] {
    const result: string[] = [];
    for (const claimId of claimIds) {
      const spans = this.claimToSpans.get(claimId);
      if (!spans || spans.size === 0) {
        result.push(claimId);
      }
    }
    return result;
  }

  /** 无证据支持的结论（带统一论证指针；保留 `unbackedClaims()` 的字符串形态）。 */
  unbackedClaimRefs(claimIds: Iterable<string>): UnbackedClaim[] {
    return this.unbackedClaims(claimIds).map(claimId => ({ claimId, ref: claimBindingRef(claimId) }));
  }

  clear(): void {
    this.claimToSpans.clear();
    this.spanToClaims.clear();
  }
}
