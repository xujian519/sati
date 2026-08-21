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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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
  protected receipts: Receipt[] = [];

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

/**
 * TeamLedger：团队共享证据账本（阶段 2）。
 *
 * 继承 Ledger 的内存语义，并把每条 Receipt 追加到团队共享 JSONL 文件
 * （路径由调用方注入，如 {caseOutputsDir}/{teamId}/evidence-ledger.jsonl）——
 * 成员各自 record、团队统一可见。按 toolCallId 去重（resume/重放不重复写）。
 *
 * 语义说明（与 turn 级 Ledger 的差异）：list()/byTool() 返回的是**团队全量历史**
 * （构造时从文件加载 + 本次 record），而非"本轮做过什么"。reset() 覆写为
 * 「从文件刷新视图」而非清空——供 EvidenceExtension 每 turn 调 startTurn 时
 * 同步其他成员新落盘的证据；消费方需要"本轮"视图时按 turnId 过滤。
 * 落盘失败的回执仅内存可见（warn），reset 后不再保留——审计侧以文件为准。
 */
export class TeamLedger extends Ledger {
  private readonly filePath: string;
  private readonly seenIds = new Set<string>();

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  override record(receipt: Receipt): void {
    if (this.seenIds.has(receipt.toolCallId)) return;
    this.seenIds.add(receipt.toolCallId);
    super.record(receipt);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(receipt) + "\n", "utf8");
    } catch (err) {
      // 落盘失败不阻断工具执行（内存已记录、本 turn 可见；reset 后不保留，审计侧以文件为准）。
      console.warn(`[sati] 团队证据账本落盘失败（仅内存可见）: ${this.filePath}`, err);
    }
  }

  override reset(): void {
    this.receipts = [];
    this.seenIds.clear();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (err) {
      // 读取失败按空账本降级（不阻断成员会话启动；审计侧 warn）。
      console.warn(`[sati] 团队证据账本读取失败（按空账本继续）: ${this.filePath}`, err);
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const receipt = JSON.parse(line) as Receipt;
        // 缺 toolCallId 的坏行跳过（防 undefined 入 seenIds/账本）。
        if (typeof receipt.toolCallId !== "string") continue;
        if (this.seenIds.has(receipt.toolCallId)) continue;
        this.seenIds.add(receipt.toolCallId);
        this.receipts.push(receipt);
      } catch {
        // 坏行跳过（追加写并发时可能读到半行）。
      }
    }
  }
}
