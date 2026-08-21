/**
 * src/patent/graph — 图引擎契约（移植自 Mady graph/pregel.go）。
 *
 * 核心语义（对齐 Mady Pregel）：
 * - 节点（GraphNode）：接收共享 state 的**深拷贝快照**，返回**增量片段**（只含自己
 *   产生的 key），引擎按 Reducer 确定性合并回共享 state —— 同超步并行无数据竞争。
 * - 边：静态边（from → to[]）+ 条件边（EdgeRouter 运行时返回目标节点列表），
 *   支持扇出（fan-out）与受控循环；GRAPH_END 哨兵表示终止。
 * - 无拓扑排序、无环检测：靠 maxSteps（默认 100）防死循环。
 */

import type { StageProvider } from "../atoms/handler.js";

/** 图共享状态（与原子层 PipelineState 同构：字符串键 → 任意值）。 */
export type GraphState = Record<string, unknown>;

/** 节点返回值：只包含自己产生的 key 的增量片段（不得返回整个 state）。 */
export type StateDelta = Record<string, unknown>;

/** 节点执行上下文：state 为深拷贝快照（本超步内所有节点看到同一版本）。 */
export type GraphNodeContext = {
  state: GraphState;
  /** 复用原子层注入点（callLLM / search）。未注入时 LLM 节点应降级而非抛错。 */
  provider?: StageProvider;
  /** 超时/取消信号（节点策略注入；节点可监听做提前退出）。 */
  signal?: AbortSignal;
};

/** 图节点：接收快照，返回增量。 */
export type GraphNode = (ctx: GraphNodeContext) => Promise<StateDelta>;

/** 条件边路由器：运行时决定下一超步目标节点列表；返回 GRAPH_END 即终止。 */
export type EdgeRouter = (state: GraphState) => string[] | Promise<string[]>;

/** 终止哨兵（保留字，不可注册为节点）。 */
export const GRAPH_END = "__end__";

/**
 * 节点策略（编译时快照，执行期不可变）：
 * - 重试：maxRetries 次，间隔 retryDelayMs * 2^(attempt-1)（指数退避）；
 * - 超时：timeoutMs 为**单次节点执行总时长（含全部重试）**，0 = 无；
 *   超时后中止重试（对齐 Mady 超时跨重试截断语义）；
 * - sideEffect：true 时返回的 delta 不合并（I/O 型节点，如通知/落盘）。
 */
export type NodePolicy = {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  sideEffect?: boolean;
};

/**
 * 同超步内并发节点写同一 key 的合并策略（Schema 注册；未注册 key 回落 LWW）：
 * - last_write_wins：节点名字典序后者覆盖（保证确定性）；
 * - append：追加到已有数组；
 * - union：数组合并去重（保持顺序）；
 * - merge_map：map 浅合并；
 * - fail_on_conflict：同 key 重复写入立即报错。
 */
export type Reducer = "last_write_wins" | "append" | "union" | "merge_map" | "fail_on_conflict";

/** 单个节点执行结果（merge 阶段输入；记录节点名保证合并确定性）。 */
export type NodeResult = {
  node: string;
  delta: StateDelta;
};

/** 节点执行失败（ok=false 时由引擎按 policy 标记降级或终止）。 */
export type NodeOutcome = { ok: true; delta: StateDelta } | { ok: false; error: unknown };

/** 运行选项（run/resume 共用）。 */
export type RunOptions = {
  provider?: StageProvider;
  /** 节点失败是否立即终止全图（默认 false：失败节点降级、其余继续）。 */
  failFast?: boolean;
  /** 每超步开始前钩子（检查点/审计预留；可 async）。 */
  onSuperStepStart?: (step: number, activeNodes: string[], state: GraphState) => void | Promise<void>;
};

/** 单节点执行耗时（阶段 0 检索耗时测量；按节点名字典序排序，确定性输出）。 */
export type NodeDuration = {
  node: string;
  /** 节点执行总耗时（含节点策略重试与超时等待）。 */
  durationMs: number;
};

/** 图运行结果。 */
export type GraphRunResult = {
  state: GraphState;
  completed: boolean;
  steps: number;
  /** 全图数据降级标记汇总（含节点失败降级）。 */
  degraded: DegradationMark[];
  /** 中断（审批门等）：存在表示暂停待人工介入，completed=false。 */
  interrupted?: { node: string; message: string; data: Record<string, unknown> };
  /** 各节点执行耗时（含中断/failFast 前已执行的节点）。 */
  nodeDurations?: NodeDuration[];
};

/** 数据级降级标记（见 degradation.ts）。 */
export type DegradationMark = {
  reason: DegradationReason;
  message: string;
  severity: "warning" | "critical";
};

/** 降级原因枚举。 */
export type DegradationReason =
  | "llm_unavailable"
  | "retriever_unavailable"
  | "search_failed"
  | "node_failed"
  | "not_implemented";

/** 节点抛出的中断信号（审批门等需要人工介入的场景）；引擎捕获后暂停执行。 */
export class GraphInterruptError extends Error {
  override readonly message: string;
  readonly data: Record<string, unknown>;

  constructor(message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "GraphInterruptError";
    this.message = message;
    this.data = data;
  }
}

export function isGraphInterruptError(err: unknown): err is GraphInterruptError {
  return err instanceof GraphInterruptError;
}

/** 图引擎错误（构建/执行/合并层）。 */
export class GraphEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphEngineError";
  }
}

/** 检查点（每超步开始前持久化：state + activeNodes + stepIndex）。 */
export type GraphCheckpoint = {
  id: string;
  graphId: string;
  /** 保存该检查点的超步序号（resume 时从该超步继续）。 */
  stepIndex: number;
  state: GraphState;
  /** 下一超步待执行节点。 */
  activeNodes: string[];
  createdAt: number;
};

/** 检查点存储契约（对齐 Mady PregelCheckpointer.CheckpointStore）。 */
export type CheckpointStore = {
  save(checkpoint: GraphCheckpoint): Promise<void>;
  load(id: string): Promise<GraphCheckpoint | undefined>;
  loadLatest(graphId: string): Promise<GraphCheckpoint | undefined>;
  list(graphId: string): Promise<string[]>;
};
