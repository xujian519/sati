/**
 * In-process pending-approval store for output-gate HITL round-trips.
 *
 * Mirrors {@link import("../permission/GatewayPermissionBus.js").GatewayPermissionBus}
 * but for patent output-gate approvals: when a patent conclusion hits the
 * approval keyword gate, the host (createLocalGateway) registers a pending
 * entry here and emits an `approval_pending` event; the Web UI eventually
 * calls `Gateway.approvalDecide({ sessionKey, pendingIndex, verdict })` and
 * the session's `approvePendingOutput` / `rejectPendingOutput` completes the
 * flow-control (the message itself is already persisted in the transcript).
 *
 * One bus per process, keyed by `sessionKey` (the gateway session key, NOT
 * the agent session id). Entries are removed when the host observes
 * onApproved / onRejected (via output-gate callbacks) or when a decision
 * is delivered through `approvalDecide`.
 */

import type { GatewayApprovalPendingInfo } from "../protocol/types.js";

/** 总线条目 = 对外 DTO + 内部定位键（sessionKey）。字段单一来源在 protocol 契约。 */
export type GatewayApprovalPending = GatewayApprovalPendingInfo & {
  /** Gateway session key（bus 按此组织；对应 gateway 的 sessionKey）。 */
  sessionKey: string;
};

export class GatewayApprovalBus {
  private readonly bySession = new Map<string, Map<number, GatewayApprovalPending>>();

  register(entry: GatewayApprovalPending): void {
    let bucket = this.bySession.get(entry.sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(entry.sessionKey, bucket);
    }
    bucket.set(entry.pendingIndex, entry);
  }

  /** 移除一条挂起审批（审批完成/挂起撤销时）。幂等：不存在返回 false。 */
  remove(sessionKey: string, pendingIndex: number): boolean {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return false;
    const removed = bucket.delete(pendingIndex);
    if (bucket.size === 0) this.bySession.delete(sessionKey);
    return removed;
  }

  /** 列出挂起审批（sessionKey 缺省列出全部；供审批列表/恢复查询）。 */
  list(sessionKey?: string): GatewayApprovalPending[] {
    if (sessionKey !== undefined) {
      return [...(this.bySession.get(sessionKey)?.values() ?? [])];
    }
    return [...this.bySession.values()].flatMap(bucket => [...bucket.values()]);
  }

  hasPending(sessionKey: string, pendingIndex: number): boolean {
    return this.bySession.get(sessionKey)?.has(pendingIndex) ?? false;
  }

  pendingCount(sessionKey?: string): number {
    if (sessionKey !== undefined) {
      return this.bySession.get(sessionKey)?.size ?? 0;
    }
    let total = 0;
    for (const bucket of this.bySession.values()) total += bucket.size;
    return total;
  }
}
