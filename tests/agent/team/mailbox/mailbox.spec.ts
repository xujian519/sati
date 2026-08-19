import assert from "node:assert/strict";
import test from "node:test";
import {
  MAILBOX_LEASE_MS,
  claimDelivery,
  expiredClaims,
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

test("claimDelivery：仅认领未认领消息，返回认领后的完整列表（不可变）", () => {
  const rows = [msg("a"), msg("b")];
  const claimedAt = "2026-08-20T00:01:00.000Z";
  const next = claimDelivery(rows, claimedAt);
  assert.notEqual(next, rows);
  assert.equal(rows[0]?.deliveryClaimedAt, undefined); // 原列表不变
  assert.equal(next[0]?.deliveryClaimedAt, claimedAt);
  assert.equal(next[1]?.deliveryClaimedAt, claimedAt);
});

test("expiredClaims：已认领未投递且超租约的（用于释放重投）", () => {
  const now = 1756000000000;
  const rows = [
    msg("a", { deliveryClaimedAt: new Date(now - MAILBOX_LEASE_MS - 1).toISOString() }),
    msg("b", { deliveryClaimedAt: new Date(now - 1000).toISOString() }),
    msg("c", { deliveredAt: "2026-08-20T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    expiredClaims(rows, now).map(m => m.id),
    ["a"],
  );
});

test("claimDelivery：已认领行保留原租约不被覆盖", () => {
  const rows = [msg("a", { deliveryClaimedAt: "2026-08-20T00:00:30.000Z" }), msg("b")];
  const next = claimDelivery(rows, "2026-08-20T00:01:00.000Z");
  assert.equal(next[0]?.deliveryClaimedAt, "2026-08-20T00:00:30.000Z");
  assert.equal(next[1]?.deliveryClaimedAt, "2026-08-20T00:01:00.000Z");
});

test("expiredClaims：恰好等于租约边界（now - LEASE_MS）不算过期（严格小于）", () => {
  const now = 1756000000000;
  const atBoundary = msg("x", { deliveryClaimedAt: new Date(now - MAILBOX_LEASE_MS).toISOString() });
  assert.deepEqual(
    expiredClaims([atBoundary], now).map(m => m.id),
    [],
  );
});
