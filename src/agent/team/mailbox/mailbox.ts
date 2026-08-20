/**
 * 成员邮箱（M2）：队长/成员间持久消息 + 投递租约。
 * 租约语义（dsh 同构）：投递前 claimDelivery 写租约，唤醒被接受后 acknowledge（delivered_at）；
 * 唤醒失败/超时由调度器锁内清 deliveryClaimedAt 释放重投（scheduler.ts kickMember 收口）。
 * 损坏行（无法解析）由调用方跳过不阻塞团队（Task 5 处理）。
 */
import type { TeamMessageRow } from "../storage/team-db.js";

export const MAILBOX_LEASE_MS = 60_000;

/** 未读判定：未投递且（未认领 或 认领租约已过期）。 */
export function unreadMessages(rows: readonly TeamMessageRow[], now: number): TeamMessageRow[] {
  const leaseStart = now - MAILBOX_LEASE_MS;
  return rows.filter(row => {
    if (row.deliveredAt !== undefined) return false;
    if (row.deliveryClaimedAt === undefined) return true;
    return Date.parse(row.deliveryClaimedAt) < leaseStart;
  });
}

/** 认领投递（写租约）；不可变更新，仅标记此前未认领的消息。 */
export function claimDelivery(rows: readonly TeamMessageRow[], claimedAt: string): TeamMessageRow[] {
  return rows.map(row => (row.deliveryClaimedAt === undefined ? { ...row, deliveryClaimedAt: claimedAt } : row));
}
