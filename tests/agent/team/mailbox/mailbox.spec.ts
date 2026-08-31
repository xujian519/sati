import assert from "node:assert/strict";
import test from "node:test";
import {
  MAILBOX_LEASE_MS,
  claimDelivery,
  unreadMessages,
  type TeamMessageRow,
} from "../../../../src/agent/team/index.js";

function msg(id: string, overrides: Partial<TeamMessageRow> = {}): TeamMessageRow {
  return {
    id,
    teamId: "t1",
    sender: "captain",
    recipient: "m1",
    content: "x",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("unreadMessages：未投递未认领（或租约过期未投递）为未读", () => {
  const now = 1756000000000;
  const rows = [
    msg("a"), // 未认领 → 未读
    msg("b", { deliveryClaimedAt: new Date(now - MAILBOX_LEASE_MS - 1).toISOString() }), // 租约过期 → 未读
    msg("c", { deliveredAt: "2026-08-20T00:00:00.000Z" }), // 已投递 → 已读
    msg("d", { deliveryClaimedAt: new Date(now - 1000).toISOString() }), // 租约内 → 不算未读
  ];
  assert.deepEqual(
    unreadMessages(rows, now).map(m => m.id),
    ["a", "b"],
  );
});

test("P1-5：unreadMessages 自定义租约宽限（leaseMs 参数取代 MAILBOX_LEASE_MS 常量）", () => {
  const now = 1756000000000;
  // 用 10s 自定义租约：expired-at now-11s → 未读；now-5s → 租约内不算未读（默认 60s 下 now-5s 也算租约内）
  const rows = [
    msg("a", { deliveryClaimedAt: new Date(now - 11_000).toISOString() }), // 超自定义窗 10s → 未读
    msg("b", { deliveryClaimedAt: new Date(now - 5_000).toISOString() }), // 自定义窗内 → 不算未读
  ];
  assert.deepEqual(
    unreadMessages(rows, now, 10_000).map(m => m.id),
    ["a"],
    "自定义 10s 租约：a 超窗未读",
  );
  // 默认 60s 下同批次两者都在租约内 → 均不算未读（对照，证明 leaseMs 已生效）
  assert.deepEqual(
    unreadMessages(rows, now).map(m => m.id),
    [],
    "默认 60s 租约：a 仍在租约内",
  );
});

test("claimDelivery：仅认领未认领消息，返回认领后的完整列表（不可变）", () => {
  const rows = [msg("a"), msg("b")];
  const claimedAt = "2026-08-20T00:01:00.000Z";
  const next = claimDelivery(rows, claimedAt);
  assert.notEqual(next, rows);
  assert.equal(rows[0]?.deliveryClaimedAt, undefined); // 原列表不变
  assert.equal(next[0]?.deliveryClaimedAt, claimedAt);
  assert.equal(next[1]?.deliveryClaimedAt, claimedAt);
});

test("claimDelivery：已认领行保留原租约不被覆盖", () => {
  const rows = [msg("a", { deliveryClaimedAt: "2026-08-20T00:00:30.000Z" }), msg("b")];
  const next = claimDelivery(rows, "2026-08-20T00:01:00.000Z");
  assert.equal(next[0]?.deliveryClaimedAt, "2026-08-20T00:00:30.000Z");
  assert.equal(next[1]?.deliveryClaimedAt, "2026-08-20T00:01:00.000Z");
});
