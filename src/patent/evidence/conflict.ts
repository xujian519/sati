/**
 * ConflictDetector 证据冲突检测（移植自 Mady agentcore/evidence/conflict.go 设计）。
 *
 * 两类冲突：
 *   1. claim 冲突：同一结论同时绑定 supporting 与 contradicting 证据
 *      （结论自相矛盾，必须人工复核）
 *   2. source 冲突：同一来源（sourceUri）的证据方向互相矛盾
 *      （来源自身不可靠/被篡改）
 *
 * 冲突不是错误 —— 检测结果供人工复核与"降置信度"提示，不自动推翻结论。
 */

import type { EvidenceSpan } from "./span.js";

export type EvidenceConflict = {
  type: "claim" | "source";
  /** claim 冲突：结论 id；source 冲突：来源 URI */
  subject: string;
  supportingIds: string[];
  contradictingIds: string[];
  description: string;
};

export class ConflictDetector {
  /**
   * 检测给定结论集合内的证据冲突。
   * @param claimIds 全部结论 id
   * @param spansByClaim claimId → 该结论的证据列表
   * @param spansById spanId → 证据实体（解析方向）
   */
  detect(input: {
    claimIds: Iterable<string>;
    spansByClaim: Map<string, string[]>;
    spansById: Map<string, EvidenceSpan>;
  }): EvidenceConflict[] {
    const conflicts: EvidenceConflict[] = [];
    for (const claimId of input.claimIds) {
      const spanIds = input.spansByClaim.get(claimId) ?? [];
      const supporting: string[] = [];
      const contradicting: string[] = [];
      for (const spanId of spanIds) {
        const span = input.spansById.get(spanId);
        if (!span) continue;
        if (span.direction === "supporting") supporting.push(spanId);
        if (span.direction === "contradicting") contradicting.push(spanId);
      }
      if (supporting.length > 0 && contradicting.length > 0) {
        conflicts.push({
          type: "claim",
          subject: claimId,
          supportingIds: supporting,
          contradictingIds: contradicting,
          description: `结论 "${claimId}" 同时存在支持与矛盾证据，需人工复核`,
        });
      }
    }

    // 同源矛盾：按 sourceUri 分组统计方向。
    const bySource = new Map<string, { supporting: string[]; contradicting: string[] }>();
    for (const [spanId, span] of input.spansById) {
      if (!span.sourceUri) continue;
      const entry = bySource.get(span.sourceUri) ?? { supporting: [], contradicting: [] };
      if (span.direction === "supporting") entry.supporting.push(spanId);
      if (span.direction === "contradicting") entry.contradicting.push(spanId);
      bySource.set(span.sourceUri, entry);
    }
    for (const [sourceUri, entry] of bySource) {
      if (entry.supporting.length > 0 && entry.contradicting.length > 0) {
        conflicts.push({
          type: "source",
          subject: sourceUri,
          supportingIds: entry.supporting,
          contradictingIds: entry.contradicting,
          description: `来源 "${sourceUri}" 同时被引为支持与矛盾证据，来源可信度存疑`,
        });
      }
    }
    return conflicts;
  }
}
