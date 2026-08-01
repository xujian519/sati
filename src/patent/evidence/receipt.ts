/**
 * 工具调用账本（移植自 Mady agentcore/evidence/receipt.go + ledger 设计）。
 *
 * 每次工具执行产生一张 Receipt（谁、何时、用什么工具、成败、读写分类），
 * 由 Ledger 按 turn 累积。Receipt 是 EvidenceSpan 的溯源底座 —— 证据的
 * receiptId 指向账本记录，实现"结论 → 证据 → 工具调用 → 参数/路径"全链路可审计。
 *
 * receiptFromToolExecution 通用适配器定义在 tool 层（src/tool/protocol/evidence.ts），
 * 此处 re-export 供领域层复用。
 */

import type { SatiEvidenceReceipt } from "../../tool/protocol/evidence.js";

export type Receipt = SatiEvidenceReceipt;

export { receiptFromToolExecution } from "../../tool/protocol/evidence.js";

/** 内容哈希（FNV-1a 32 位，十六进制）——用于证据原文完整性校验。 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Ledger：turn 级工具账本。每 turn 开始 reset（对齐 Mady BeforeTurn 语义），
 * 支持按工具名检索 —— 证据/审计消费方据此还原"本轮做过什么"。
 */
export class Ledger {
  private receipts: Receipt[] = [];

  reset(): void {
    this.receipts = [];
  }

  record(receipt: Receipt): void {
    this.receipts.push(receipt);
  }

  list(): Receipt[] {
    return [...this.receipts];
  }

  byTool(toolName: string): Receipt[] {
    return this.receipts.filter(r => r.toolName === toolName);
  }

  size(): number {
    return this.receipts.length;
  }
}
