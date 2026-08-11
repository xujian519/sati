/**
 * src/patent/graph — 数据级降级标记（移植自 Mady graph/degradation.go）。
 *
 * 与"异常抛出"不同：当外部依赖（LLM/检索器/知识源）不可用时，节点写入
 * fallback 值 + 并列标记 key（`<valueKey>__degradation`），下游节点与报告
 * 可读取"该数据来自降级"并继续执行 —— 失败即降级，绝不让全图崩溃。
 */

import type { DegradationMark, DegradationReason, GraphState, StateDelta } from "./types.js";

/** 降级标记并列 key 后缀。 */
export const DEGRADATION_SUFFIX = "__degradation";

/**
 * 标记降级：把 fallback 写入 valueKey，降级说明写入 `<valueKey>__degradation`。
 * 供节点内部使用（delta 是节点即将返回的增量片段）。
 */
export function markDegraded(
  delta: StateDelta,
  valueKey: string,
  fallback: unknown,
  reason: DegradationReason,
  message: string,
  severity: DegradationMark["severity"] = "warning",
): void {
  delta[valueKey] = fallback;
  delta[`${valueKey}${DEGRADATION_SUFFIX}`] = { reason, message, severity } satisfies DegradationMark;
}

/** 查询某 key 是否被降级。 */
export function isDegraded(state: GraphState, valueKey: string): boolean {
  return state[`${valueKey}${DEGRADATION_SUFFIX}`] !== undefined;
}

/** 读取某 key 的降级标记（无则 undefined）。 */
export function getDegradationMark(state: GraphState, valueKey: string): DegradationMark | undefined {
  const mark = state[`${valueKey}${DEGRADATION_SUFFIX}`];
  if (
    typeof mark === "object" &&
    mark !== null &&
    typeof (mark as { reason?: unknown }).reason === "string" &&
    typeof (mark as { message?: unknown }).message === "string"
  ) {
    return mark as DegradationMark;
  }
  return undefined;
}

/** 全图降级标记汇总（按 key 字典序，确定性输出）。 */
export function degradationSummary(state: GraphState): DegradationMark[] {
  const marks: DegradationMark[] = [];
  for (const key of Object.keys(state).sort()) {
    if (!key.endsWith(DEGRADATION_SUFFIX)) continue;
    const mark = state[key];
    if (
      typeof mark === "object" &&
      mark !== null &&
      typeof (mark as { reason?: unknown }).reason === "string" &&
      typeof (mark as { message?: unknown }).message === "string"
    ) {
      marks.push(mark as DegradationMark);
    }
  }
  return marks;
}
