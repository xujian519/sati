/**
 * src/patent/graph — 适配层：现有 StageHandler / WorkflowManifest → 图节点。
 *
 * 兼容策略（新引擎 + 兼容层）：
 * - runStageHandler / handlerNode（domains/shared）：现有原子 handler 直接作为
 *   图节点，保留降级/中断语义；
 * - manifestToGraph：现有 WorkflowManifest（线性阶段 + retry 信号回退）转为图，
 *   行为与 runWorkflow 尽力等价（重试/降级文本等已知差异见 README）——retry
 *   回退转条件边（受控循环），approval-gate 中断转 GraphInterruptError（引擎暂停）。
 */

import type { WorkflowContext, WorkflowManifest, WorkflowStage } from "../workflow.js";
import { validateWorkflowManifest } from "../workflow.js";
import { signalMatches } from "../workflow/signal.js";
import type { AtomRegistry, StageHandler, StageHandlerRegistry, StageProvider } from "../atoms/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry, isInterruptStageError } from "../atoms/index.js";
import type { EdgeRouter, GraphNode, GraphState, StateDelta } from "./types.js";
import { GRAPH_END, GraphEngineError, GraphInterruptError } from "./types.js";
import { GraphBuilder, type CompiledGraph } from "./engine.js";
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
    const execState = stage.params !== undefined ? { ...state, ...stage.params } : state;
    const delta: StateDelta = {};
    let output = "";
    if (handler !== undefined) {
      const segment = await runStageHandler(handler, execState, deps.provider ?? provider);
      Object.assign(delta, segment);
      const raw = mainKey !== undefined ? segment[mainKey] : undefined;
      output = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw, null, 2);
      if (output.trim().length === 0) output = String(execState[stage.id] ?? "");
    } else if (deps.executor !== undefined) {
      output = (await deps.executor(stage, execState as WorkflowContext)) ?? "";
    }
    delta[stage.id] = output;
    if (output.trim().length === 0 && handler === undefined && deps.executor === undefined) {
      // 无 handler 无 executor：降级标记（对齐 runWorkflow 的 degraded 阶段）。
      delta[`${stage.id}__degraded`] = true;
    }
    return delta;
  };
}

// ---------------------------------------------------------------------------
// retry 信号回退（信号判定复用 ./workflow/signal.js 单一实现，防语义漂移）
// ---------------------------------------------------------------------------

/** 重试计数/超限标记 key（state 内部键，带 __ 前缀防污染业务数据）。 */
const rewindCountKey = (stageId: string): string => `_rewind_count_${stageId}`;
const retryExhaustedKey = (stageId: string): string => `${stageId}__retry_exhausted`;

/** retry 阶段 → 条件边 router：命中信号回退 rewindTo，否则继续 nextId。 */
function makeRetryRouter(
  stage: WorkflowStage,
  stages: WorkflowStage[],
  nextId: string,
  atoms: AtomRegistry,
): EdgeRouter {
  const retry = stage.retry!;
  const rewindTo = retry.rewindTo ?? stage.id;
  const maxRetries = retry.maxRetries ?? 1;
  const signal = new RegExp(retry.whenOutputMatches, "gi");
  // 被回退阶段集合（rewindTo .. 当前阶段），回退时删除其 state 键与原子输出键
  // 防陈旧复用（对齐 runWorkflow 的 rewind 清理语义）。
  const rewindIndex = stages.findIndex(s => s.id === rewindTo);
  const currentIndex = stages.findIndex(s => s.id === stage.id);
  const rewindedIds =
    rewindIndex === -1 || currentIndex === -1 ? [stage.id] : stages.slice(rewindIndex, currentIndex + 1).map(s => s.id);

  return async state => {
    const text = getStateString(state, stage.id, "");
    if (text.length === 0 || !signalMatches(text, signal)) {
      return [nextId];
    }
    const countKey = rewindCountKey(stage.id);
    const count = typeof state[countKey] === "number" ? (state[countKey] as number) : 0;
    if (count >= maxRetries) {
      // 超限：fail-open 继续（对齐 runWorkflow 的 WORKFLOW_RETRY_EXHAUSTED 降级）。
      state[retryExhaustedKey(stage.id)] = true;
      return [nextId];
    }
    state[countKey] = count + 1;
    for (const id of rewindedIds) {
      delete (state as GraphState)[id];
      const atom = stages.find(s => s.id === id)?.atom;
      if (atom !== undefined) {
        for (const key of atoms.lookup(atom)?.outputSchema ?? []) {
          delete (state as GraphState)[key];
        }
      }
    }
    return [rewindTo];
  };
}
