/**
 * src/patent/workflow — 单阶段执行器（参数化）。
 *
 * 从 workflow.ts 拆出（A10 轮次 3）：runStageOnce 从 runWorkflow 闭包抽为
 * 显式参数化函数，消除 7 个闭包变量捕获。副作用时序契约（勿改）：
 * - Object.assign(state, segment) 在 handler 产出后立即合并（state 引用共享）；
 * - 主输出键 / 空输出兜底 / 审批门占位 = `./stage-primitives.js`（与图路径共用单一实现）；
 * - degraded 前缀 `[WORKFLOW_DEGRADED]` 保留错误信息；
 * - approvedGate 经 APPROVAL_GRANTED_KEY 注入 execState（与图路径同一契约）。
 */

import {
  APPROVAL_GRANTED_KEY,
  type AtomRegistry,
  type PipelineState,
  type StageHandlerRegistry,
  type StageProvider,
  isInterruptStageError,
} from "../atoms/index.js";
import type { WorkerContract, WorkerOutputValidation } from "../worker-contract.js";
import { defaultPatentWorkers, validateWorkerOutput } from "../worker-contract.js";
import { isApprovalGateStage, resolveStageOutput } from "./stage-primitives.js";
import type { StageExecutor, WorkflowContext, WorkflowInterrupt, WorkflowStage } from "./types.js";

export type RunStageOnceOptions = {
  handlers: StageHandlerRegistry;
  atoms: AtomRegistry;
  provider?: StageProvider;
  executor?: StageExecutor;
  maxRetries: number;
  approvalGrants?: string[];
  ctx: WorkflowContext;
  /** worker 契约目录（name → 契约）；缺省构建 defaultPatentWorkers 目录。 */
  workers?: Map<string, WorkerContract>;
};

export type StageOnceOutcome = {
  output: string;
  retries: number;
  interrupted?: WorkflowInterrupt;
  /** worker 契约校验结果（stage.worker 命中目录时）。 */
  workerValidation?: WorkerOutputValidation;
};

/**
 * 执行单个 stage（含重试循环与 degraded 输出构造），不处理信号回退。
 * 供 runWorkflow 串行路径与并行组共用；state 为调用方持有的共享对象（原地合并）。
 */
export async function runStageOnce(
  stage: WorkflowStage,
  state: PipelineState,
  options: RunStageOnceOptions,
): Promise<StageOnceOutcome> {
  const handler = stage.atom !== undefined ? options.handlers.lookup(stage.atom) : undefined;
  let output = "";
  let retries = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      if (handler) {
        // 已人工批准的审批门：把放行标记注入 handler 执行态，由 ApprovalGateHandler
        // 统一判定放行（与图路径同一契约）；此处不跳过执行。
        // ⚠️ 执行态必须总为拷贝（含无 params 阶段）：放行标记只许 handler 局部可见，
        // 直接写共享 state 会污染后续所有审批门（曾因此发生"无 params 的已批准门
        // 放行后全链路审批门静默放行"的事故，tests/patent/drafting-sop.spec.ts 覆盖）。
        const approvedGate = isApprovalGateStage(handler) && options.approvalGrants?.includes(stage.id) === true;
        // 阶段静态参数合并进执行态（不污染共享 state，仅本次 handler 可见）。
        const execState = { ...state, ...(stage.params ?? {}) };
        if (approvedGate) {
          execState[APPROVAL_GRANTED_KEY] = true;
        }
        const segment = await handler.execute({ state: execState, provider: options.provider });
        Object.assign(state, segment);
        // 主输出键 = atom.outputSchema[0]（对齐 Mady 约定，文本/JSON 均可）；兜底按 stage.id 引用。
        // 输出解析与审批门占位是 graph 路径共用的原语（#345）——顺序契约见其模块注释。
        const mainKey = stage.atom !== undefined ? options.atoms.lookup(stage.atom)?.outputSchema?.[0] : undefined;
        output = resolveStageOutput({ segment, mainKey, fallbackValue: state[stage.id], approvedGate });
        state[stage.id] = output;
      } else if (options.executor) {
        output = (await options.executor(stage, options.ctx)) ?? "";
      }
      if (output.trim().length > 0) break;
      lastError = new Error("阶段执行未产生输出");
    } catch (err) {
      if (isInterruptStageError(err)) {
        return { output: "", retries, interrupted: { stageId: stage.id, message: err.message, data: err.data } };
      }
      lastError = err;
      retries += 1;
      if (attempt >= options.maxRetries) {
        output = "";
        break;
      }
    }
    retries = attempt + 1;
  }

  if (
    output.trim().length === 0 &&
    lastError !== undefined &&
    !(lastError instanceof Error && lastError.message === "阶段执行未产生输出")
  ) {
    // 保留错误信息到输出，便于诊断；仍标记 degraded。
    // 用结构化标记前缀（而非中文字面量），避免与 executor 正常输出冲突。
    output = `[WORKFLOW_DEGRADED] ${stage.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  }
  // Worker 契约校验（仅提示，不改变 degraded 判定）：stage.worker 声明且命中目录时，
  // 用 requiredFields 子串校验阶段产出；缺失清单附到结果供 HITL/审计展示。
  let workerValidation: WorkerOutputValidation | undefined;
  if (stage.worker !== undefined && output.trim().length > 0) {
    const workers = options.workers ?? buildDefaultWorkerMap();
    const contract = workers.get(stage.worker);
    if (contract !== undefined) {
      workerValidation = validateWorkerOutput(contract, output);
    }
  }
  return { output, retries, workerValidation };
}

/** 构建 defaultPatentWorkers 目录（轻量；runWorkflow 复用同一 Map 避免重复构建）。 */
export function buildDefaultWorkerMap(): Map<string, WorkerContract> {
  return new Map(defaultPatentWorkers().map(worker => [worker.name, worker]));
}
