/**
 * src/patent/provenance — 决策溯源层协议（对齐 W3C PROV-O 简化语义）。
 *
 * 为专利分析结论提供可查询、可导出、可回溯的决策记录（方案 §3.1）：
 *   - activity：一次决策/执行活动（图节点、worker、审批、降级）
 *   - entity：活动产出（结论/证据/状态快照/输出文件/审批摘要）
 *   - agent：执行者（llm/human/rule_gate/retrieval/system）
 * 关系以 JSON 数组列表达（used=input_ids、wasDerivedFrom=derived_from、
 * wasGeneratedBy=generated_by），不建独立 edge 表（评审 A1）。
 */

/** 活动来源（审计口径统一枚举；output_gate/flexible_plan 为全局库，无 caseId 归属）。 */
export type ProvenanceSource =
  | "graph_node" // 图节点执行（Phase 2）
  | "worker" // worker 契约执行（Phase 1）
  | "output_gate" // PatentOutputGate 审批（Phase 1，全局库）
  | "approval_gate" // manifest/graph 审批门放行（Phase 1）
  | "flexible_plan" // flexible-plan 阶段确认/回退（全局库）
  | "degradation"; // 降级标记（Phase 2）

export type ProvenanceActivity = {
  /** 幂等键：`${runId}:${source}:${step}:${nodeName}`（无 seq；并行超步下确定性，评审 P2）。 */
  id: string;
  source: ProvenanceSource;
  /** 节点名 / worker 名 / 审批动作。 */
  name: string;
  /** per-case 库必有值；output_gate/flexible_plan 可为空（无 session→case 映射）。 */
  caseId: string | null;
  /** 工具层生成的运行实例 id（resume 复用同一实例，新运行新 id）。 */
  runId: string;
  stepIndex?: number;
  startedAt: number;
  durationMs?: number;
  /** 执行者（llm/human/rule_gate/retrieval/system 的 id）。 */
  agentId: string;
  /** used 边：活动使用了哪些 Entity（Phase 2 来自声明表；审批/worker 天然已知）。 */
  inputIds: string[];
};

export type ProvenanceEntity = {
  id: string;
  kind: "conclusion" | "evidence" | "state_snapshot" | "output_file" | "approval";
  /** 结论文本 / 证据引用 / 文件路径 / 审批摘要。 */
  value: string;
  caseId: string | null;
  /** wasGeneratedBy。 */
  generatedByActivityId?: string;
  /** wasDerivedFrom：决策链骨架。 */
  derivedFromIds: string[];
  /** 是否为降级产物。 */
  degraded?: boolean;
};

export type ProvenanceAgent = {
  id: string;
  kind: "llm" | "human" | "rule_gate" | "retrieval" | "system";
  name: string;
  model?: string;
};
