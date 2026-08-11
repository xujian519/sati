/**
 * src/patent/graph — 节点策略执行（移植自 Mady graph/node_policy.go）。
 *
 * 单次节点执行封装：
 * - 超时：timeoutMs 为**总时长（含全部重试）**，超时注入 AbortSignal 并中止重试；
 * - 重试：maxRetries 次，间隔 retryDelayMs * 2^(attempt-1)（指数退避）；
 * - panic 捕获：节点同步抛错统一转为失败结果；
 * - sideEffect：delta 不合并（调用方决定，见 engine）。
 */

import type { GraphNode, GraphNodeContext, NodeOutcome, NodePolicy } from "./types.js";
import { isGraphInterruptError } from "./types.js";

/** 默认重试间隔基准（ms）。 */
const DEFAULT_RETRY_DELAY_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 按策略执行节点（含重试/超时/panic 捕获）。
 * 返回 { ok: true, delta } 或 { ok: false, error }；不抛错（中断错误除外，由 engine 另行处理）。
 */
export async function runNodeWithPolicy(
  node: GraphNode,
  policy: NodePolicy | undefined,
  ctx: GraphNodeContext,
): Promise<NodeOutcome> {
  const maxRetries = policy?.maxRetries ?? 0;
  const timeoutMs = policy?.timeoutMs ?? 0;
  const retryDelayMs = policy?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (deadline !== null && Date.now() >= deadline) {
      return { ok: false, error: lastError ?? new Error(`节点执行超时（${timeoutMs}ms，含 ${maxRetries} 次重试）`) };
    }
    const controller = new AbortController();
    const remaining = deadline !== null ? Math.max(0, deadline - Date.now()) : 0;
    const timer = deadline !== null ? setTimeout(() => controller.abort(), remaining) : null;
    try {
      const delta = await node({ ...ctx, signal: controller.signal });
      // 超时后完成的节点视为失败（超时语义：总时长截止后不再采信结果）。
      if (controller.signal.aborted) {
        return { ok: false, error: new Error("节点执行超时（结果在超时后返回）") };
      }
      // sideEffect 节点：delta 不合并（返回空片段，由调用方忽略）。
      return policy?.sideEffect === true ? { ok: true, delta: {} } : { ok: true, delta };
    } catch (err) {
      // 中断错误（审批门等）：穿透不重试（由引擎转为 interrupted 暂停）。
      if (isGraphInterruptError(err)) throw err;
      lastError = err;
      if (controller.signal.aborted) {
        // 超时：中止重试（对齐 Mady 超时跨重试截断）。
        return { ok: false, error: err };
      }
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError ?? new Error("节点执行失败") };
}
