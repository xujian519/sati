/**
 * src/patent/graph — 适配层：现有 StageHandler / WorkflowManifest → 图节点。
 *
 * 兼容策略（新引擎 + 兼容层）：
 * - runStageHandler / handlerNode（domains/shared）：现有原子 handler 直接作为
 *   图节点，保留降级/中断语义；
 * - manifestToGraph：现有 WorkflowManifest（线性阶段 + retry 信号回退）转为图，
 *   行为与 runWorkflow 尽力等价（重试/降级文本等已知差异见 README）——retry
 *   回退转条件边（受控循环），approval-gate 中断转 GraphInterruptError（引擎暂停）。
 * - 阶段输出解析（主输出键 / 空输出兜底 / 审批门占位）与回退清理**不是本文件自有语义**：
 *   单一实现在 ../workflow/stage-primitives.js，与 manifest 路径共用（#345）。
 */

import type { WorkflowContext, WorkflowManifest, WorkflowStage } from "../workflow.js";
import { validateWorkflowManifest } from "../workflow.js";
import { needsRedo } from "../workflow/signal.js";
import { closeRevision, readRevisionLedger, recordRewind, writeRevisionLedger } from "../workflow/revision.js";
import { clearStageOutputs, isApprovalGateStage, resolveStageOutput } from "../workflow/stage-primitives.js";
import {
  APPROVAL_GRANTED_KEY,
  isGateApproved,
  type AtomRegistry,
  type StageHandler,
  type StageHandlerRegistry,
  type StageProvider,
} from "../atoms/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry, isInterruptStageError } from "../atoms/index.js";
import type { EdgeRouter, GraphNode, GraphState, StateDelta } from "./types.js";
import { GRAPH_END, GraphEngineError, GraphInterruptError } from "./types.js";
import type { DegradationMark } from "./types.js";
import { GraphBuilder, type CompiledGraph } from "./engine.js";
import { DEGRADATION_SUFFIX, markDegraded } from "./degradation.js";
import { getStateString } from "./state.js";

// ---------------------------------------------------------------------------
// runStageHandler —— StageHandler → 图节点执行（统一中断转换）
// ---------------------------------------------------------------------------

/**
 * 执行 StageHandler 并统一中断转换（供 handlerNode / makeStageNode 复用）：
 * - InterruptStageError（审批门）→ GraphInterruptError（引擎暂停）；
 * - 普通错误重新抛出（引擎经节点策略转为节点级降级标记，不中断全图）。
 */
export async function runStageHandler(
  handler: StageHandler,
  state: GraphState,
  provider?: StageProvider,
): Promise<StateDelta> {
  try {
    return await handler.execute({ state, provider });
  } catch (err) {
    if (isInterruptStageError(err)) {
      throw new GraphInterruptError(err.message, err.data);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// manifestToGraph
// ---------------------------------------------------------------------------

export type ManifestToGraphDeps = {
  /** 缺省 globalStageHandlerRegistry。 */
  handlers?: StageHandlerRegistry;
  /** 缺省 globalAtomRegistry（解析 atom.outputSchema[0] 主输出键）。 */
  atoms?: AtomRegistry;
  /** 未声明 atom 阶段的执行器（对齐 runWorkflow 的 executor 参数）。 */
  executor?: (stage: WorkflowStage, ctx: WorkflowContext) => Promise<string>;
  provider?: StageProvider;
};

/**
 * 现有 WorkflowManifest → 图（顺序边 + retry 条件边）。
 * 与 runWorkflow 语义对齐点：
 * - 阶段输出写入 state[stage.id]（主输出键 = atom.outputSchema[0]，兜底 stage.id）；
 * - retry 信号回退：条件边 router 判定输出文本（含否定窗口），命中且未超限 →
 *   回退 rewindTo（删除被回退阶段 state 键）；超限 → fail-open 继续；
 * - approval-gate 阶段抛 GraphInterruptError → 引擎暂停。
 */
export function manifestToGraph(manifest: WorkflowManifest, deps: ManifestToGraphDeps = {}): CompiledGraph {
  // 校验对齐 runWorkflow：先 validateWorkflowManifest，再 fail-fast atom 契约存在性。
  validateWorkflowManifest(manifest);
  const handlers = deps.handlers ?? globalStageHandlerRegistry;
  const atoms = deps.atoms ?? globalAtomRegistry;
  for (const stage of manifest.stages) {
    if (stage.atom !== undefined && atoms.lookup(stage.atom) === undefined) {
      throw new GraphEngineError(`阶段 "${stage.id}" 声明了未知 atom "${stage.atom}"（请先 RegisterAtom）`);
    }
  }

  const builder = new GraphBuilder();
  for (const stage of manifest.stages) {
    builder.addNode(
      stage.id,
      makeStageNode(stage, { handlers, atoms, executor: deps.executor, provider: deps.provider }),
    );
  }

  for (let i = 0; i < manifest.stages.length; i += 1) {
    const stage = manifest.stages[i]!;
    const nextId = manifest.stages[i + 1]?.id ?? GRAPH_END;
    if (stage.retry !== undefined) {
      builder.setConditionalEdge(stage.id, makeRetryRouter(stage, manifest.stages, nextId, atoms));
    } else {
      builder.addEdge(stage.id, nextId);
    }
  }

  return builder.compile(manifest.stages[0]!.id);
}

/** 阶段 → 图节点（对齐 runWorkflow.runStageOnce 语义）。 */
function makeStageNode(
  stage: WorkflowStage,
  deps: {
    handlers: StageHandlerRegistry;
    atoms: AtomRegistry;
    executor?: ManifestToGraphDeps["executor"];
    provider?: StageProvider;
  },
): GraphNode {
  const handler = stage.atom !== undefined ? deps.handlers.lookup(stage.atom) : undefined;
  const mainKey = stage.atom !== undefined ? deps.atoms.lookup(stage.atom)?.outputSchema?.[0] : undefined;
  return async ({ state, provider }) => {
    // 门粒度放行（与 manifest 路径的 approvalGrants: stageId[] 同构）：本节点在图中以
    // stage.id 注册（见 manifestToGraph 的 addNode），故按 stage.id 判自己是否被批准。
    const approvedGate = isApprovalGateStage(handler) && isGateApproved(state, stage.id);
    // ⚠️ 放行标记只许 handler 局部可见：注入**执行态拷贝**，绝不写入共享 state——否则
    // 一次放行会污染同一 run 内后续所有审批门（同型事故见 workflow/executor.ts 注释）。
    const execState: GraphState =
      stage.params !== undefined || approvedGate
        ? { ...state, ...stage.params, ...(approvedGate ? { [APPROVAL_GRANTED_KEY]: true } : {}) }
        : state;
    const delta: StateDelta = {};
    let output = "";
    if (handler !== undefined) {
      const segment = await runStageHandler(handler, execState, deps.provider ?? provider);
      Object.assign(delta, segment);
      // 放行判据与 handler 所见执行态同源（ApprovalGateHandler 内部同样判
      // state[APPROVAL_GRANTED_KEY]），故「已放行」与「补占位输出」恒同时成立。
      // #345 前缺此分支：同一 manifest 的已批准审批门在两条链路下 state 不同
      // （图路径 ""，manifest 路径 "APPROVED"）。
      // 主输出键解析 / 空输出兜底 / 审批门占位 = 与 manifest 路径共用单一实现。
      output = resolveStageOutput({ segment, mainKey, fallbackValue: execState[stage.id], approvedGate });
    } else if (deps.executor !== undefined) {
      output = (await deps.executor(stage, execState as WorkflowContext)) ?? "";
    }
    delta[stage.id] = output;
    if (output.trim().length === 0 && handler === undefined && deps.executor === undefined) {
      // 无 handler 无 executor：该阶段根本没有可执行体（≠ 执行失败），
      // 走引擎**已消费**的降级通道，与 manifest 路径的 `degraded: true` 对齐。
      // #345 前此处写 `<id>__degraded`，而该键全仓无读取者（`degradationSummary`
      // 只认 `__degradation` 后缀）⇒ 无人值守路径上「阶段未执行」被静默报成成功。
      markDegraded(
        delta,
        stage.id,
        output,
        "not_implemented",
        `阶段 "${stage.id}" 无可执行体（无 handler 也无 executor）`,
        "critical",
      );
    }
    return delta;
  };
}

// ---------------------------------------------------------------------------
// retry 回退（判定复用 ./workflow/signal.js 的 needsRedo、留痕复用 ./workflow/revision.js，
// 与 manifest 路径同一实现，防语义漂移）
// ---------------------------------------------------------------------------

/** 重试计数/超限标记 key（state 内部键，带 __ 前缀防污染业务数据）。 */
const rewindCountKey = (stageId: string): string => `_rewind_count_${stageId}`;
const retryExhaustedKey = (stageId: string): string => `${stageId}__retry_exhausted`;

/** retry 阶段 → 条件边 router：命中判定回退 rewindTo，否则继续 nextId。 */
function makeRetryRouter(
  stage: WorkflowStage,
  stages: WorkflowStage[],
  nextId: string,
  atoms: AtomRegistry,
): EdgeRouter {
  const retry = stage.retry!;
  const rewindTo = retry.rewindTo ?? stage.id;
  const maxRetries = retry.maxRetries ?? 1;
  const signal = retry.whenOutputMatches !== undefined ? new RegExp(retry.whenOutputMatches, "gi") : undefined;
  // 被回退阶段集合（rewindTo .. 当前阶段），回退时删除其 state 键与原子输出键
  // 防陈旧复用（对齐 runWorkflow 的 rewind 清理语义）。
  const rewindIndex = stages.findIndex(s => s.id === rewindTo);
  const currentIndex = stages.findIndex(s => s.id === stage.id);
  const rewindedStages =
    rewindIndex === -1 || currentIndex === -1 ? [stage] : stages.slice(rewindIndex, currentIndex + 1);

  return async state => {
    const text = getStateString(state, stage.id, "");
    if (text.length === 0) {
      // 无输出：既无结构化判据也无正则输入；挂起记录保持 interrupted（不伪装闭合）。
      return [nextId];
    }
    // 触发判定与 manifest 路径共用 needsRedo（结构化优先、正则兜底）。
    const decision = needsRedo(stage, text, signal);
    const ledger = readRevisionLedger(state);
    if (decision === undefined) {
      // 只声明 whenOutputGaps 且输出不可解析：不回退，但写降级标记（降级不静默）。
      closeRevision(ledger, stage.id, text);
      writeRevisionLedger(state, ledger);
      state[`${stage.id}${DEGRADATION_SUFFIX}`] = {
        reason: "retry_signal_unparseable",
        message: `节点 "${stage.id}" 声明 whenOutputGaps，但输出不是严格 JSON 且未声明 whenOutputMatches：本次未做回退判定（结构化触发不可用）`,
        severity: "warning",
      } satisfies DegradationMark;
      return [nextId];
    }
    if (!decision.redo) {
      // 触发阶段重跑完成且不再需要回退：闭合上一轮挂起的记录。
      closeRevision(ledger, stage.id, text);
      writeRevisionLedger(state, ledger);
      return [nextId];
    }
    const countKey = rewindCountKey(stage.id);
    const count = typeof state[countKey] === "number" ? (state[countKey] as number) : 0;
    if (count >= maxRetries) {
      // 超限：fail-open 继续（对齐 runWorkflow 的 WORKFLOW_RETRY_EXHAUSTED 降级）。
      // 上一轮挂起记录以超限输出闭合（这是该阶段本轮的真实产出）。
      closeRevision(ledger, stage.id, `[WORKFLOW_RETRY_EXHAUSTED] ${stage.id}: ${text}`);
      writeRevisionLedger(state, ledger);
      state[retryExhaustedKey(stage.id)] = true;
      return [nextId];
    }
    // 先闭合上一轮挂起记录（无论本轮是否再次触发），再为本轮回退开新记录。
    closeRevision(ledger, stage.id, text);
    recordRewind(ledger, {
      stageId: stage.id,
      output: text,
      gapId: decision.gapIds.length > 0 ? decision.gapIds.join("+") : `pattern:${stage.id}`,
      rationale: decision.rationale,
    });
    writeRevisionLedger(state, ledger);
    state[countKey] = count + 1;
    // 清理被回退阶段的 state 键与其 atom 输出键（防陈旧复用）——与 manifest 路径
    // 共用单一实现；范围差异（此处清到当前阶段为止）见该函数的模块注释。
    clearStageOutputs({ state, stages: rewindedStages, atoms });
    return [rewindTo];
  };
}
