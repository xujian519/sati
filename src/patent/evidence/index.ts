/**
 * src/patent/evidence — 证据闭环（通用账本层，无领域判定）。
 *
 * 分层（对齐 Mady agentcore/evidence ↔ domains/evidence 分离）：
 * - span.ts：EvidenceSpan 可定位原文切片 + 方向语义
 * - receipt.ts：工具调用账本（Receipt/Ledger）
 * - claimBinding.ts：结论 ↔ 证据绑定 + UnbackedClaims
 * - conflict.ts：冲突检测（claim 冲突 / source 冲突）
 * - 本文件：EvidenceExtension 聚合（实现 tool 层 SatiEvidenceCollector）
 *
 * 领域判定（三性/证明标准）明确留二期 —— 本期只做"记录与回溯"。
 */

import type { SatiEvidenceCollector, SatiEvidenceReceipt } from "../../tool/protocol/evidence.js";
import { ClaimBinding } from "./claimBinding.js";
import { ConflictDetector, type EvidenceConflict } from "./conflict.js";
import { Ledger, contentHash, type Receipt } from "./receipt.js";
import { createSpan, type EvidenceDirection, type EvidenceSpan } from "./span.js";

export { type EvidenceSpan, type EvidenceDirection, createSpan, isLocatable } from "./span.js";
export {
  Ledger,
  TeamLedger,
  contentHash,
  receiptFromToolExecution,
  type Receipt,
  type TeamEvidenceDeclaration,
  type TeamEvidenceConflict,
} from "./receipt.js";
export { ClaimBinding } from "./claimBinding.js";
export { ConflictDetector, type EvidenceConflict } from "./conflict.js";
export {
  EvidenceEngine,
  inferEvidenceType,
  evaluateFourElements,
  STANDARD_PREPONDERANCE,
  STANDARD_CLEAR_CONVINCING,
} from "./engine.js";
export type {
  EvidenceJudgment,
  DimensionJudgment,
  TypeSpecificJudgment,
  BurdenDetermination,
  ProofStandardResult,
  EvidenceRule,
  EvidenceRuleSet,
  EvidenceType,
  CredibilityLevel,
  DateDetermination,
  FourElementsResult,
} from "./types.js";
export { platformCredibility, credibilityToScore, platformCategory, evaluatePublicIntent } from "./credibility.js";
export {
  parseDateFlexible,
  isPreciseDate,
  isMonthOnlyDate,
  inferredMonthEnd,
  extractDateFromText,
  isBeforeFilingDate,
  determinePublicationDate,
  extractWaybackMachineDate,
  cleanEvidenceURI,
} from "./date.js";
export { loadEvidenceRulesEngine } from "./rule-loader.js";

/**
 * EvidenceExtension：证据闭环聚合体（实现 SatiEvidenceCollector）。
 * 经 ToolRuntime 自动收 Receipt 入 Ledger；上层把 Receipt 提升为 EvidenceSpan、
 * 绑定结论，再查询无证据支持结论与冲突。
 */
export class EvidenceExtension implements SatiEvidenceCollector {
  readonly ledger = new Ledger();
  readonly binding = new ClaimBinding();
  readonly conflicts = new ConflictDetector();
  private readonly spans = new Map<string, EvidenceSpan>();

  /** 每 turn 开始调用：账本重置（对齐 Mady BeforeTurn 语义）。 */
  startTurn(): void {
    this.ledger.reset();
  }

  /** SatiEvidenceCollector 实现：ToolRuntime 每次工具执行后调用。 */
  recordReceipt(receipt: SatiEvidenceReceipt): void {
    this.ledger.record(receipt as Receipt);
  }

  /** 把 Receipt 提升为 EvidenceSpan（方向由调用方/领域层指定）。 */
  spanFromReceipt(receipt: Receipt, direction: EvidenceDirection, snippet?: string): EvidenceSpan {
    const span = createSpan({
      turnId: receipt.turnId,
      receiptId: receipt.toolCallId,
      docVersion: undefined,
      pageRange: undefined,
      charRange: undefined,
      contentHash: receipt.resultText ? contentHash(receipt.resultText) : undefined,
      snippet: snippet ?? receipt.resultText,
      sourceUri: receipt.path ? `file://${receipt.path}` : undefined,
      direction,
    });
    this.spans.set(span.id, span);
    return span;
  }

  /** 注册已构造的证据（供跨 turn 恢复/外部导入）。 */
  registerSpan(span: EvidenceSpan): void {
    this.spans.set(span.id, span);
  }

  getSpan(spanId: string): EvidenceSpan | undefined {
    return this.spans.get(spanId);
  }

  listSpans(): EvidenceSpan[] {
    return [...this.spans.values()];
  }

  bind(claimId: string, spanId: string): void {
    this.binding.bind(claimId, spanId);
    const span = this.spans.get(spanId);
    if (span) {
      span.claimRefs = [...new Set([...(span.claimRefs ?? []), claimId])];
    }
  }

  /** 无证据支持的结论列表（结论必须显式登记为 claim）。 */
  unbackedClaims(claimIds: Iterable<string>): string[] {
    return this.binding.unbackedClaims(claimIds);
  }

  /**
   * 无证据支持提示：存在无证据结论时返回人读提示（供质量门/工具调用），
   * 无则返回 undefined（不打断流程，仅提示降级）。
   */
  unbackedNotice(claimIds: Iterable<string>): string | undefined {
    const unbacked = this.binding.unbackedClaims(claimIds);
    if (unbacked.length === 0) return undefined;
    return `以下结论缺少证据支持（Unbacked Claims）: ${unbacked.join("、")} —— 请人工复核或补充证据来源。`;
  }

  /** 检测给定结论集合内的证据冲突。 */
  detectConflicts(claimIds: Iterable<string>): EvidenceConflict[] {
    const ids = [...claimIds];
    const spansByClaim = new Map<string, string[]>();
    for (const claimId of ids) {
      spansByClaim.set(claimId, this.binding.spansForClaim(claimId));
    }
    return this.conflicts.detect({ claimIds: ids, spansByClaim, spansById: this.spans });
  }

  clear(): void {
    this.ledger.reset();
    this.binding.clear();
    this.spans.clear();
  }
}
