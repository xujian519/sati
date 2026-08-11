/**
 * src/patent/graph — Reducer 确定性合并（移植自 Mady graph/state_schema.go）。
 *
 * 同超步内所有节点并行执行后，结果按 **节点名字典序** 排序再逐 key 合并：
 * - 排序保证 LWW 确定性（并发写同一 key 时，字典序后者胜出，与执行完成顺序无关）；
 * - 未注册 schema 的 key 回落 last_write_wins；
 * - fail_on_conflict：同 key 重复写入立即抛 GraphMergeError。
 */

import type { GraphState, NodeResult, Reducer } from "./types.js";
import { GraphEngineError } from "./types.js";

/** 合并 schema：key → Reducer。 */
export type MergeSchema = Record<string, Reducer>;

/** 把单值转为数组（append/union 用）；已是数组原样返回。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** union 去重键（规范化字符串，避免对象引用比较）。 */
function unionKey(value: unknown): string {
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return `${typeof value}:${String(value)}`;
}

function appendValue(existing: unknown, value: unknown): unknown[] {
  return [...asArray(existing), value];
}

function unionValues(existing: unknown, value: unknown): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of [...asArray(existing), ...(Array.isArray(value) ? value : [value])]) {
    const key = unionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function mergeMap(existing: unknown, value: unknown): unknown {
  const base =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const incoming =
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { ...base, ...incoming };
}

/**
 * 合并节点增量到共享 state（原地修改）。
 * results 按节点名字典序排序后逐 key 应用 Reducer。
 */
export function mergeWithSchema(state: GraphState, results: NodeResult[], schema: MergeSchema = {}): void {
  const sorted = [...results].sort((a, b) => a.node.localeCompare(b.node));
  for (const { node, delta } of sorted) {
    for (const [key, value] of Object.entries(delta)) {
      const reducer: Reducer = schema[key] ?? "last_write_wins";
      switch (reducer) {
        case "last_write_wins":
          state[key] = value;
          break;
        case "append":
          state[key] = appendValue(state[key], value);
          break;
        case "union":
          state[key] = unionValues(state[key], value);
          break;
        case "merge_map":
          state[key] = mergeMap(state[key], value);
          break;
        case "fail_on_conflict":
          if (key in state) {
            throw new GraphMergeError(`同超步内节点 "${node}" 写入 key "${key}" 与既有值冲突（fail_on_conflict）`);
          }
          state[key] = value;
          break;
        default: {
          const exhaustive: never = reducer;
          throw new GraphMergeError(`未知 Reducer: ${String(exhaustive)}`);
        }
      }
    }
  }
}

/** 合并错误（fail_on_conflict 触发）。 */
export class GraphMergeError extends GraphEngineError {
  constructor(message: string) {
    super(message);
    this.name = "GraphMergeError";
  }
}
