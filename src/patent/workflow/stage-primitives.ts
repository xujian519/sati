/**
 * src/patent/workflow — 阶段执行原语（manifest 路径与图路径的**唯一实现**）。
 *
 * 背景（#345）：同一条「跑一个阶段并取出主输出」的语义原先在三处各写一遍
 * （`graph/adapter.ts:makeStageNode`、`workflow/executor.ts:runStageOnce`、
 * `workflow.ts` 的回退清理），且**已经发生漂移**——图路径缺审批门占位分支，
 * 于是同一 manifest 在两条链路下 `state[gateStageId]` 不同（`""` vs `"APPROVED"`）。
 *
 * 本模块把该语义收敛为一处，调用方只声明各自差异（参数化，不做「为整齐而强行归一」）：
 * - **空输出兜底的取值源**：两侧 state 对象不同（图路径是合并 params 后的执行态），
 *   故 `fallbackValue` 由调用方传入而非在此处取 `state[stage.id]`；
 * - **回退清理的范围**：图路径清到「当前阶段」为止，manifest 路径清到清单末尾
 *   （后者是超集，但两者都只触及**尚未产生结果**的阶段键，故无观察差异；
 *   保留各自范围以免引入行为变更）。
 *
 * 与 `./signal.js` 同一先例：语义的单一实现放本目录，图路径 import 之防漂移。
 */

import {
  APPROVAL_GRANTED_OUTPUT,
  type AtomRegistry,
  type PipelineState,
  type StageHandler,
  isApprovalGateHandler,
} from "../atoms/index.js";
import type { WorkflowStage } from "./types.js";

/**
 * 该阶段的 handler 是否为「人工放行型审批门」（放行时无实质输出，需补占位）。
 * 仅是 `isApprovalGateHandler` 的容空包装——两侧都需要「handler 可能未注册」的
 * 同一判据，避免各自的 `!== undefined` 写法再次分叉。
 */
export function isApprovalGateStage(handler: StageHandler | undefined): boolean {
  return handler !== undefined && isApprovalGateHandler(handler);
}

export type ResolveStageOutputOptions = {
  /** handler 返回的片段（无 handler 时省略）。 */
  segment?: PipelineState;
  /** 主输出键 = `atom.outputSchema[0]`；undefined 表示契约未声明主输出。 */
  mainKey?: string;
  /** 空输出兜底值：调用方传入 `state[stage.id]`（取值源两侧不同，见模块注释）。 */
  fallbackValue?: unknown;
  /** 已放行的审批门：放行后无实质输出时写占位，避免被判 degraded。 */
  approvedGate?: boolean;
};

/**
 * 阶段产出 → 输出文本。单一实现，两侧共用（顺序即契约，勿擅改）：
 * 1. 主输出键 `atom.outputSchema[0]`：字符串原样 / undefined 视作空 / 其余 JSON 序列化；
 * 2. 仍为空 → 兜底 `fallbackValue`（对齐「空输出回退 state[stage.id]」）；
 * 3. 仍为空且该阶段是已放行的审批门 → `APPROVAL_GRANTED_OUTPUT` 占位
 *    （语义 = 已人工批准，不是降级）。
 */
export function resolveStageOutput(options: ResolveStageOutputOptions): string {
  const raw =
    options.segment !== undefined && options.mainKey !== undefined ? options.segment[options.mainKey] : undefined;
  let output = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw, null, 2);
  if (output.trim().length === 0) {
    output = String(options.fallbackValue ?? "");
  }
  if (options.approvedGate === true && output.trim().length === 0) {
    output = APPROVAL_GRANTED_OUTPUT;
  }
  return output;
}

export type ClearStageOutputsOptions = {
  /** 原地清理（调用方持有的共享 state）。 */
  state: PipelineState;
  /** 待清理的阶段集合——**范围由调用方决定**（见模块注释）。 */
  stages: readonly WorkflowStage[];
  atoms: AtomRegistry;
};

/**
 * 回退清理：删除被回退阶段的 stage-id 键与其 atom 的 `outputSchema` 全部键。
 *
 * 只删 stage-id 键是不够的——重跑中某路解析失败（如 extract 非 JSON 保留原文）
 * 会残留旧一代数组，下游 merge 混用两代提取结果且无降级告警（2026-08 修复，
 * 见 `tests/patent/graph/adapter.spec.ts` 的「不残留混代」用例）。
 */
export function clearStageOutputs(options: ClearStageOutputsOptions): void {
  const { state, stages, atoms } = options;
  for (const stage of stages) {
    delete state[stage.id];
    if (stage.atom !== undefined) {
      for (const key of atoms.lookup(stage.atom)?.outputSchema ?? []) {
        delete state[key];
      }
    }
  }
}
