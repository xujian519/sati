/**
 * src/patent/provenance — 审批审计全局库落盘（ApprovalStore 的 SQLite 实现）。
 *
 * 走 PatentOutputGate 的 approvalStore 注入点（output-gate.ts:64，现成接口），
 * 落全局库 `~/.sati/provenance/approval-audit.db`（SATI_PROVENANCE_DIR 覆盖）。
 * output_gate 审批发生在 AgentLoop 消息层，无 case 归属时 case_id 置 NULL 不伪造
 * （方案 P1）；activity.id 幂等键防重复。
 *
 * fail-open（评审 P8）：PatentOutputGate.swallowRejection 只吞 thenable 的 rejected
 * promise（output-gate.ts:333-336），同步抛错会穿透 approve/reject——本实现
 * saveRecord 内部 try/catch，审计写入失败绝不阻断审批流程。
 */

import { join } from "node:path";
import type { ApprovalRecord, ApprovalStore } from "../approval.js";
import { provenanceAuditDir } from "../paths.js";
import { createLogger } from "../../telemetry/index.js";
import { ProvenanceStore } from "./provenance-store.js";

const logger = createLogger("SqliteApprovalStore");

/** 全局审批审计库文件名。 */
export const APPROVAL_AUDIT_DB = "approval-audit.db";

/** 审批 activity 幂等键：session（或 global）+ 挂起索引 + 决策时刻，同一条只记一次。 */
function approvalActivityId(record: ApprovalRecord): string {
  const scope = record.sessionId ?? "global";
  return `output_gate:${scope}:${record.pendingIndex}:${record.decidedAt}`;
}

export class SqliteApprovalStore implements ApprovalStore {
  private readonly store: ProvenanceStore;

  /** dbPath 可注入（测试用）；缺省全局审计库路径。 */
  constructor(dbPath?: string) {
    this.store = new ProvenanceStore(dbPath ?? join(provenanceAuditDir(), APPROVAL_AUDIT_DB));
  }

  /** 追加一条审计记录（只增；失败静默告警，绝不外泄）。 */
  saveRecord(record: ApprovalRecord): void {
    try {
      const activityId = approvalActivityId(record);
      const decidedAt = Number.isNaN(Date.parse(record.decidedAt)) ? Date.now() : Date.parse(record.decidedAt);
      const caseId = record.caseId ?? null;
      this.store.upsertAgent({ id: "human", kind: "human", name: "审批人" });
      this.store.upsertActivity({
        id: activityId,
        source: "output_gate",
        name: record.verdict,
        caseId,
        runId: record.runId ?? `output_gate:${record.sessionId ?? "global"}`,
        startedAt: decidedAt,
        agentId: "human",
        inputIds: [],
      });
      this.store.upsertEntity({
        id: `entity:${activityId}`,
        kind: "approval",
        // 完整记录 JSON（originalOutputPreview 已在 createApprovalRecord 截断至 500 字符）
        value: JSON.stringify(record),
        caseId,
        generatedByActivityId: activityId,
        derivedFromIds: [],
      });
    } catch (err) {
      // fail-open：审计写入失败不影响审批流程
      logger.error("审批审计写入失败:", err);
    }
  }

  /** 列出全部审计记录（按决定时间升序；坏记录跳过）。 */
  listRecords(): ApprovalRecord[] {
    try {
      return this.store
        .listEntities(undefined)
        .filter(e => e.kind === "approval")
        .map(e => {
          try {
            return JSON.parse(e.value) as ApprovalRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is ApprovalRecord => r !== null)
        .sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
    } catch {
      return [];
    }
  }

  /** 释放句柄（进程收尾/测试用）。 */
  close(): void {
    this.store.close();
  }
}
