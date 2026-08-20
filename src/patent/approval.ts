/**
 * 审批审计闭环（对齐 Mady domains/approval/approval.go 的 ApprovalRecord 设计）。
 *
 * PatentOutputGate（output-gate.ts）已有：审批词关键词门 + 挂起队列 + approve/reject
 * 流程控制 + SuppressPersist 语义。本模块补齐**决策留痕**：
 *   - ApprovalRecord：谁、哪个关键词触发、AI 原文摘录、人工如何决策（adopted/
 *     modified/rejected）、何时 —— 只增审计日志（用于 AdoptionRate 指标与
 *     Golden Benchmark 转换，对齐 Mady 明确用途）
 *   - ApprovalStore：审计存储接口 + 内存实现（JSON 落盘实现留二期）
 *
 * 设计原则：审计写入不阻塞审批流程（fail-open）；store 未配置时零开销。
 */

import type { RuleViolation } from "../rule/index.js";

export type ApprovalVerdict = "adopted" | "modified" | "rejected";

export type ApprovalRecord = {
  /** 挂起索引（对应 PatentOutputGate 的 pending index） */
  pendingIndex: number;
  sessionId?: string;
  turnId?: string;
  /** 触发审批的关键词 */
  triggerKeyword: string;
  /** AI 原文摘录（供审计/复核，截断至 500 字符） */
  originalOutputPreview: string;
  verdict: ApprovalVerdict;
  /** modified 时的替换输出 */
  modifiedOutput?: string;
  /** rejected 时的人工反馈理由 */
  feedback?: string;
  decidedAt: string;
  /** 溯源扩展（provenance 旁路，可选）：output_gate 在 agent 消息层，无 case 归属时留空。 */
  caseId?: string;
  runId?: string;
  /** 规则门禁违规清单（ruleGate 命中挂起时才有；供审计链 derivedFrom 溯源）。 */
  ruleViolations?: RuleViolation[];
};

export type ApprovalStore = {
  /** 追加一条审计记录（只增）。可返回 Promise（异步落盘实现）。 */
  saveRecord(record: ApprovalRecord): void | Promise<void>;
  /** 列出全部审计记录（按决定时间升序）。 */
  listRecords(): ApprovalRecord[];
};

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records: ApprovalRecord[] = [];

  saveRecord(record: ApprovalRecord): void {
    this.records.push(record);
  }

  listRecords(): ApprovalRecord[] {
    return [...this.records];
  }

  /** 按结论统计（AdoptionRate = adopted / total；供指标与 Golden Benchmark）。 */
  stats(): { total: number; adopted: number; modified: number; rejected: number; adoptionRate: number } {
    const total = this.records.length;
    const adopted = this.records.filter(r => r.verdict === "adopted").length;
    const modified = this.records.filter(r => r.verdict === "modified").length;
    const rejected = this.records.filter(r => r.verdict === "rejected").length;
    return { total, adopted, modified, rejected, adoptionRate: total > 0 ? adopted / total : 0 };
  }
}

/** 构造审计记录（供 PatentOutputGate approve/reject 调用）。now 为可注入时钟（默认系统时钟，与 TurnRunner 注入对齐）。 */
export function createApprovalRecord(input: {
  pendingIndex: number;
  sessionId?: string;
  turnId?: string;
  triggerKeyword: string;
  originalOutputPreview: string;
  verdict: ApprovalVerdict;
  modifiedOutput?: string;
  feedback?: string;
  caseId?: string;
  runId?: string;
  ruleViolations?: RuleViolation[];
  now?: () => Date;
}): ApprovalRecord {
  return {
    pendingIndex: input.pendingIndex,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    triggerKeyword: input.triggerKeyword,
    originalOutputPreview: input.originalOutputPreview.slice(0, 500),
    verdict: input.verdict,
    ...(input.modifiedOutput !== undefined ? { modifiedOutput: input.modifiedOutput } : {}),
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.ruleViolations !== undefined ? { ruleViolations: input.ruleViolations } : {}),
    decidedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}
