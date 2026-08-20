/**
 * src/patent/provenance — 溯源收集器（ProvenanceCollector）。
 *
 * 已实现（T3）：审批门溯源（pending/granted）；T4：worker 契约执行溯源；
 * T8 扩展 wrapGraphBuilder 图节点收集与降级记录。旁路写入，不改动既有逻辑。
 *
 * activity.id 幂等键：`${runId}:<source>:<stage>:<seq>`——
 * 同 run 同审批门同状态只记一次（resume 重放安全）；新运行因 runId 实例化
 * （run-id.ts）天然区分，不覆盖前次审计历史。
 */

import type { WorkerExecutionRecord } from "../worker-contract.js";
import { ProvenanceStore } from "./provenance-store.js";

export type ProvenanceCollectorOptions = {
  store: ProvenanceStore;
  runId: string;
  caseId: string | null;
};

export type ApprovalGateRecord = {
  /** manifest stageId 或图节点名（graph 审批门放行时用 "checkpoint:<id>"）。 */
  stageId: string;
  kind: "pending" | "granted";
  /** 复核上下文 / 审批说明。 */
  message?: string;
  /** 决策时刻（缺省 Date.now）。 */
  at?: number;
};

export class ProvenanceCollector {
  readonly runId: string;
  readonly caseId: string | null;
  private readonly store: ProvenanceStore;
  /** worker 记录序号：同 run 同 worker 多次执行仍唯一（worker 记录为运行期实时产生，无重放语义）。 */
  private workerSeq = 0;

  constructor(options: ProvenanceCollectorOptions) {
    this.store = options.store;
    this.runId = options.runId;
    this.caseId = options.caseId;
  }

  /** 记录一条审批门活动（挂起 pending / 放行 granted）。 */
  recordApprovalGate(record: ApprovalGateRecord): void {
    const id = `${this.runId}:approval_gate:${record.stageId}:${record.kind}`;
    this.store.upsertAgent({ id: "human", kind: "human", name: "审批人" });
    this.store.upsertActivity({
      id,
      source: "approval_gate",
      name: record.kind,
      caseId: this.caseId,
      runId: this.runId,
      startedAt: record.at ?? Date.now(),
      agentId: "human",
      inputIds: [],
    });
    this.store.upsertEntity({
      id: `entity:${id}`,
      kind: "approval",
      value: JSON.stringify({ stageId: record.stageId, kind: record.kind, message: record.message ?? "" }),
      caseId: this.caseId,
      generatedByActivityId: id,
      derivedFromIds: [],
    });
  }

  /** 记录一条 worker 契约执行（activity + output_file entity）。 */
  recordWorker(input: { record: WorkerExecutionRecord; outputPath?: string }): void {
    this.workerSeq += 1;
    const id = `${this.runId}:worker:${input.record.workerName}:${this.workerSeq}`;
    this.store.upsertAgent({ id: input.record.workerName, kind: "system", name: input.record.workerName });
    this.store.upsertActivity({
      id,
      source: "worker",
      name: input.record.workerName,
      caseId: this.caseId,
      runId: this.runId,
      startedAt: input.record.startedAt,
      durationMs: input.record.durationMs,
      agentId: input.record.workerName,
      inputIds: [],
    });
    this.store.upsertEntity({
      id: `entity:${id}`,
      kind: "output_file",
      value: input.outputPath ?? "",
      caseId: this.caseId,
      generatedByActivityId: id,
      derivedFromIds: [],
      degraded: input.record.degraded,
    });
  }

  /** 释放句柄（工具调用结束时调用）。 */
  close(): void {
    this.store.close();
  }
}
