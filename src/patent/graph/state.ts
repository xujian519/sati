/**
 * src/patent/graph — 图状态工具：深拷贝快照 + 类型安全读写。
 *
 * 深拷贝用 structuredClone（Node >= 17 全局可用；本项目 Node >= 22.13），
 * 保留 int64/Date 等类型（不做 JSON 往返），对齐 Mady PregelState.Clone 的
 * "保留类型"设计意图。
 */

import type { GraphState } from "./types.js";

/** 深拷贝图状态（BSP 快照）。structuredClone 失败时降级 JSON 往返。 */
export function cloneState(state: GraphState): GraphState {
  try {
    return structuredClone(state) as GraphState;
  } catch {
    // 兜底：含不可克隆值（函数/类实例）时 JSON 往返（仅拷贝可序列化键）。
    return JSON.parse(JSON.stringify(state)) as GraphState;
  }
}

/** 类型安全读取字符串键（键不存在或非字符串返回缺省）。 */
export function getStateString(state: GraphState, key: string, fallback = ""): string {
  const value = state[key];
  return typeof value === "string" ? value : fallback;
}

/** 类型安全读取数组键（非数组返回空数组）。 */
export function getStateArray(state: GraphState, key: string): unknown[] {
  const value = state[key];
  return Array.isArray(value) ? value : [];
}

/** 类型安全读取对象键（非对象返回空对象）。 */
export function getStateObject(state: GraphState, key: string): Record<string, unknown> {
  const value = state[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
