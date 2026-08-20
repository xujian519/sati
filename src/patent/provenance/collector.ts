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

import { DEGRADATION_SUFFIX } from "../graph/degradation.js";
import type { DegradationMark, GraphNode, GraphNodeContext, StateDelta } from "../graph/types.js";
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
  /** 当前超步号（图路径）：由工具层 onSuperStepStart 更新；非图场景不参与。 */
  private currentStep = 0;
  /** 已写入快照的 state key 集合（评审 I1：inputIds 存在性校验，悬空引用不写）。 */
  private readonly writtenSnapshotKeys = new Set<string>();

  constructor(options: ProvenanceCollectorOptions) {
    this.store = options.store;
    this.runId = options.runId;
    this.caseId = options.caseId;
  }

  /**
   * fail-open 统一包装（评审 C1）：审计写失败绝不外泄——wrapNode 场景下外泄会把
   * 成功节点翻转成 node_failed 并丢弃其产出（engine 把 promise reject 当节点失败）。
   * 所有写操作必须经此包装，新增写方法不得绕过。
   */
  private failOpen(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[ProvenanceCollector] ${what}:`, err);
    }
  }

  /** 记录一条审批门活动（挂起 pending / 放行 granted）。 */
  recordApprovalGate(record: ApprovalGateRecord): void {
    this.failOpen(`审批门记录 (${record.stageId})`, () => {
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
    });
  }

  /** 记录一条 worker 契约执行（activity + output_file entity）。 */
  recordWorker(input: { record: WorkerExecutionRecord; outputPath?: string }): void {
    // 评审 C2：onRecord 无 try/catch 时 store 抛错会经 monitor.record 上抛中止整个 workflow。
    this.failOpen(`worker 记录 (${input.record.workerName})`, () => {
      // 评审 I4：id 用执行时刻（record.startedAt）而非进程内自增 seq——
      // resume 续跑新 collector 的 seq 从 0 起，会与崩溃前记录 id 碰撞并被
      // INSERT OR IGNORE 静默丢弃；执行时刻在 resume 重跑时天然不同。
      const id = `${this.runId}:worker:${input.record.workerName}:${input.record.startedAt}`;
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
    });
  }

  /** 更新当前超步号（图路径，工具层 onSuperStepStart 调用）。 */
  setCurrentStep(step: number): void {
    this.currentStep = step;
  }

  /**
   * 图节点统一入口包装（评审 P9）：在 GraphBuilder 的 onAddNode 钩子调用，
   * 覆盖工厂节点与裸箭头节点。declaredInputKeys 来自子图声明表（缺失只记产出
   * 不伪造因果）。产出 delta keys → state_snapshot entity（REPLACE 最新值）。
   */
  wrapNode(name: string, node: GraphNode, declaredInputKeys?: readonly string[]): GraphNode {
    return async (ctx: GraphNodeContext) => {
      const started = Date.now();
      const delta = await node(ctx);
      this.recordGraphNode({ name, delta, declaredInputKeys, startedAt: started });
      return delta;
    };
  }

  /** 记录一次图节点执行（activity + 产出快照 entities）。 */
  private recordGraphNode(input: {
    name: string;
    delta: StateDelta;
    declaredInputKeys?: readonly string[];
    startedAt: number;
  }): void {
    this.failOpen(`图节点记录 (${input.name})`, () => {
      const activityId = `${this.runId}:graph_node:${input.name}:${this.currentStep}`;
      const written = Object.keys(input.delta);
      // 评审 I1：只记录已产生的快照键（悬空引用不写 inputIds，避免导出"输入"指向不存在实体）
      const validInputs = (input.declaredInputKeys ?? []).filter(k => this.writtenSnapshotKeys.has(k));
      const inputIds = validInputs.map(k => `${this.runId}:snapshot:${k}`);
      this.store.upsertAgent({ id: "system", kind: "system", name: "图引擎节点" });
      this.store.upsertActivity({
        id: activityId,
        source: "graph_node",
        name: input.name,
        caseId: this.caseId,
        runId: this.runId,
        stepIndex: this.currentStep,
        startedAt: input.startedAt,
        agentId: "system",
        inputIds,
      });
      for (const key of written) {
        // 内部键（_ 前缀，如 _prior_art_converged）不记录为快照；__degradation 后缀记录为降级快照。
        if (key.startsWith("_") && !key.endsWith(DEGRADATION_SUFFIX)) continue;
        this.writtenSnapshotKeys.add(key);
        this.store.upsertEntityLatest({
          id: `${this.runId}:snapshot:${key}`,
          kind: "state_snapshot",
          value:
            typeof input.delta[key] === "string"
              ? (input.delta[key] as string)
              : JSON.stringify(input.delta[key] ?? ""),
          caseId: this.caseId,
          generatedByActivityId: activityId,
          derivedFromIds: [],
          degraded: key.endsWith(DEGRADATION_SUFFIX),
        });
      }
    });
  }

  /** 记录全图降级标记（结果侧，评审 P9：覆盖引擎级直接写 state 的降级路径）。 */
  recordDegradations(marks: readonly DegradationMark[]): void {
    for (const mark of marks) {
      this.failOpen(`降级记录 (${mark.reason})`, () => {
        const id = `${this.runId}:degradation:${mark.reason}:${mark.message}`;
        this.store.upsertActivity({
          id,
          source: "degradation",
          name: mark.reason,
          caseId: this.caseId,
          runId: this.runId,
          startedAt: Date.now(),
          agentId: "system",
          inputIds: [],
        });
        this.store.upsertEntity({
          id: `entity:${id}`,
          kind: "state_snapshot",
          value: mark.message,
          caseId: this.caseId,
          generatedByActivityId: id,
          derivedFromIds: [],
          degraded: true,
        });
      });
    }
  }

  /** 释放句柄（工具调用结束时调用）。 */
  close(): void {
    this.store.close();
  }
}
