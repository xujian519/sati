/**
 * src/patent/workflow — 声明式工作流类型契约。
 *
 * 从 workflow.ts 拆出（轮次 1 纯搬移）：类型/接口 + WorkflowError，供执行器
 * 与消费方（workflow-store / workflow-dag / graph/adapter / flexible-plan /
 * 工具层）共享，解除对执行器文件的类型级耦合。
 */

import type { AtomRegistry, StageHandlerRegistry, StageProvider } from "../atoms/index.js";

export type WorkflowStrategy = "chain" | "react" | "sub_agent";

export type WorkflowStage = {
  id: string;
  strategy: WorkflowStrategy;
  description: string;
  /**
   * 可选：Pipeline 原子操作名（如 "extract"/"search"/"compare"/"reasoning"/"approval-gate"）。
   * 声明后 runWorkflow 按 atom 分发到 StageHandler；缺省回退 executor。
   */
  atom?: string;
  /**
   * 可选：传递给 StageHandler 的静态参数（执行前合并进 PipelineState，handler 经 state 读取）。
   * 用于同一原子在不同阶段的差异化配置（如 extract 三路的 output_key / extraction_type）。
   */
  params?: Record<string, unknown>;
  /**
   * 可选：一致性重试循环（对齐 Mady disclosure 管线的 check_consistency 条件回退边）。
   * 本阶段输出匹配 whenOutputMatches（信号：需要重做）时，回退到 rewindTo 阶段
   * 重新执行（含中间阶段），最多 maxRetries 次。
   */
  retry?: {
    /** 触发回退的输出信号（正则源文本；如 "不一致|矛盾|缺少"）。 */
    whenOutputMatches: string;
    /** 回退目标阶段 id；缺省重试当前阶段。 */
    rewindTo?: string;
    /** 最大回退次数（缺省 1）。 */
    maxRetries?: number;
  };
};

export type WorkflowManifest = {
  id: string;
  name: string;
  caseType: string;
  stages: WorkflowStage[];
  validation?: {
    /** 是否要求所有步骤都产生输出（缺省 true） */
    requireAllSteps?: boolean;
    maxRetries?: number;
  };
};

export type WorkflowContext = {
  /** 案例目录或案例 ID，用于输入输出路径（可含 {caseId} 占位） */
  caseId?: string;
  /** 用户输入/初始事实 */
  input?: string;
  [key: string]: unknown;
};

export type StageExecutor = (stage: WorkflowStage, ctx: WorkflowContext) => Promise<string>;

export type WorkflowRunOptions = {
  /** 阶段处理器注册表（缺省全局注册表）。传空注册表可禁用原子执行（收口语义）。 */
  handlers?: StageHandlerRegistry;
  /** Atom 声明注册表（缺省全局注册表），用于解析 atom.outputSchema[0] 主输出键。 */
  atoms?: AtomRegistry;
  /** 原子执行所需的外部能力（LLM/检索器），由宿主注入。 */
  provider?: StageProvider;
  /**
   * 已人工批准的审批门阶段 id 列表：命中时跳过执行直接放行（输出 "APPROVED"），
   * 未命中的审批门照常中断。人工批准后重跑时传入，实现"审批门通过后继续"。
   */
  approvalGrants?: string[];
  /**
   * 结果持久化存储：执行结束时调用 saveRun（可选）。
   * 设计对齐 src/workflow WorkflowPlanStore（save/load/list 三接口），
   * 实现见 ./workflow-store.js。
   */
  persist?: WorkflowRunStore;
  /** 持久化键（runId），用于区分同一 manifest 的多次执行；缺省 manifestId。 */
  runId?: string;
};

export type WorkflowStageResult = {
  stageId: string;
  strategy: WorkflowStrategy;
  output: string;
  /** 该步骤是否降级（无输出时标记，不中断流程） */
  degraded: boolean;
  retries: number;
  /** 该阶段声明的原子名（如有） */
  atom?: string;
};

export type WorkflowInterrupt = {
  stageId: string;
  message: string;
  data: Record<string, unknown>;
};

export type WorkflowRunResult = {
  manifestId: string;
  caseType: string;
  completed: boolean;
  stages: WorkflowStageResult[];
  /** 未产生输出的步骤 id */
  degradedSteps: string[];
  summary: string;
  /** 审批门等中断信息：存在表示执行被人工介入暂停（暂停 ≠ 失败） */
  interrupted?: WorkflowInterrupt;
  /** 可选：结果持久化失败时的告警（执行本身不受影响） */
  persistWarning?: string;
};

/**
 * WorkflowRun 持久化契约（对齐 src/workflow/persistence/WorkflowPlanStore 的
 * save/load/list 三接口；此处持久化对象为 patent 域的 WorkflowRunResult）。
 * 实现见 ./workflow-store.js（InMemory / JsonFile 两种后端）。
 */
export interface WorkflowRunStore {
  saveRun(result: WorkflowRunResult, runId?: string): Promise<void>;
  loadRun(runId: string): Promise<WorkflowRunResult | undefined>;
  listRuns(): Promise<string[]>;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}
