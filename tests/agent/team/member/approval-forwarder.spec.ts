/**
 * TeamApprovalForwarder：成员 approval_pending → 队长会话 watcher 转发；决定回写成员 sessionKey。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayEvent } from "../../../../src/gateway/protocol/types.js";
import { TeamApprovalForwarder, TeamDb, createTeamMember } from "../../../../src/agent/team/index.js";

function setup(): {
  db: TeamDb;
  forwarder: TeamApprovalForwarder;
  emitted: Array<{ sessionKey: string; event: GatewayEvent }>;
  decided: Array<{ sessionKey: string; pendingIndex: number; verdict: string; feedback?: string }>;
} {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
  const emitted: Array<{ sessionKey: string; event: GatewayEvent }> = [];
  const decided: Array<{ sessionKey: string; pendingIndex: number; verdict: string; feedback?: string }> = [];
  const forwarder = new TeamApprovalForwarder({
    db,
    emitForSession: (sessionKey, event) => {
      emitted.push({ sessionKey, event });
      return true;
    },
    approvalDecide: async input => {
      decided.push({
        sessionKey: input.sessionKey,
        pendingIndex: input.pendingIndex,
        verdict: input.verdict,
        ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
      });
      return { delivered: true };
    },
  });
  return { db, forwarder, emitted, decided };
}

const pendingEvent = (memberSessionKey: string): GatewayEvent => ({
  type: "approval_pending",
  sessionKey: memberSessionKey,
  pendingIndex: 1,
  textPreview: "结论待审批",
  triggerKeyword: "可专利性",
  sessionId: memberSessionKey,
  createdAt: 1756000000000,
});

test("转发：成员 approval_pending 转发到队长会话 watcher（标注成员来源）", () => {
  const { db, forwarder, emitted } = setup();
  try {
    const member = db.getMember("m1")!;
    forwarder.handleMemberEvent(member, pendingEvent("team:t1:m1"));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.sessionKey, "cap-1");
    const event = emitted[0]?.event as Extract<GatewayEvent, { type: "approval_pending" }>;
    assert.equal(event.sessionKey, "cap-1");
    assert.equal(event.sessionId, "team:t1:m1"); // 保留成员来源
    assert.equal(event.pendingIndex, 1);
  } finally {
    db.close();
  }
});

test("转发：非 approval 事件忽略", () => {
  const { db, forwarder, emitted } = setup();
  try {
    const member = db.getMember("m1")!;
    forwarder.handleMemberEvent(member, { type: "turn_completed", usage: {}, finishReason: "completed" });
    assert.equal(emitted.length, 0);
  } finally {
    db.close();
  }
});

test("转发：无团队的成员事件忽略（不抛错）", () => {
  const { db, forwarder, emitted } = setup();
  try {
    // 造一个 teamId 不存在的成员行（直接插库绕过 createTeamMember 的 team 存在性）
    db.insertMember({
      id: "m-orphan",
      teamId: "missing-team",
      roleSlug: "x",
      modelRouteJson: "{}",
      status: "idle",
      sessionKey: "team:missing-team:m-orphan",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const orphan = db.getMember("m-orphan")!;
    forwarder.handleMemberEvent(orphan, pendingEvent("team:missing-team:m-orphan"));
    assert.equal(emitted.length, 0);
  } finally {
    db.close();
  }
});

test("决定回写：队长决定回写成员 sessionKey", async () => {
  const { db, forwarder, decided } = setup();
  try {
    const result = await forwarder.decide("cap-1", "team:t1:m1", 1, "adopted");
    assert.equal(result.delivered, true);
    assert.deepEqual(decided, [{ sessionKey: "team:t1:m1", pendingIndex: 1, verdict: "adopted" }]);
  } finally {
    db.close();
  }
});

test("决定回写：rejected + feedback 透传", async () => {
  const { db, forwarder, decided } = setup();
  try {
    const result = await forwarder.decide("cap-1", "team:t1:m1", 2, "rejected", "证据不足，请补充检索");
    assert.equal(result.delivered, true);
    assert.deepEqual(decided, [
      { sessionKey: "team:t1:m1", pendingIndex: 2, verdict: "rejected", feedback: "证据不足，请补充检索" },
    ]);
  } finally {
    db.close();
  }
});

test("决定回写：队长与成员不同队时拒绝（安全校验）", async () => {
  const { db, forwarder, decided } = setup();
  try {
    db.upsertTeam({ id: "t2", name: "另一队", captainSessionKey: "cap-2", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, { teamId: "t2", memberId: "m2", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    const result = await forwarder.decide("cap-1", "team:t2:m2", 1, "adopted");
    assert.equal(result.delivered, false);
    assert.equal(decided.length, 0);
  } finally {
    db.close();
  }
});

test("决定回写：delivered:false 收敛删除持久化挂起项（P0-3 兜底）", async () => {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
  // 模拟冷恢复前落表的一条挂起审批（bus 为内存态，此刻仅表里有）
  db.upsertPendingApproval({
    teamId: "t1",
    memberId: "m1",
    sessionKey: "team:t1:m1",
    pendingIndex: 3,
    triggerKeyword: "可专利性",
    textPreview: "结论待审批",
    createdAt: "2026-08-19T00:00:00.000Z",
  });
  try {
    const decided: Array<{ sessionKey: string; pendingIndex: number }> = [];
    const forwarder = new TeamApprovalForwarder({
      db,
      emitForSession: () => true,
      approvalDecide: async input => {
        decided.push({ sessionKey: input.sessionKey, pendingIndex: input.pendingIndex });
        return { delivered: false }; // 成员会话不在路由/审批已决——送达失败
      },
    });
    const result = await forwarder.decide("cap-1", "team:t1:m1", 3, "rejected", "需补充检索");
    assert.equal(result.delivered, false);
    assert.equal(decided.length, 1);
    assert.equal(decided[0]?.sessionKey, "team:t1:m1");
    assert.equal(decided[0]?.pendingIndex, 3);
    // 送达失败 → 持久化挂起项被删除：hasPendingApproval 不再永久跳过该成员（否则持续冒泡
    // member_stalled_approval 且永不 self-heal）
    assert.equal(db.hasPendingApproval("team:t1:m1"), false);
    assert.equal(db.getPendingApproval("team:t1:m1", 3), undefined);
  } finally {
    db.close();
  }
});

test("决定回写：delivered:true 不在 forwarder 删除持久化项（由 resolveApproval 收口，避免双删竞态）", async () => {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
  db.upsertPendingApproval({
    teamId: "t1",
    memberId: "m1",
    sessionKey: "team:t1:m1",
    pendingIndex: 1,
    triggerKeyword: "可专利性",
    textPreview: "结论待审批",
    createdAt: "2026-08-19T00:00:00.000Z",
  });
  try {
    const forwarder = new TeamApprovalForwarder({
      db,
      emitForSession: () => true,
      approvalDecide: async () => ({ delivered: true }), // 命中在路会话，onApproved → resolveApproval 删表
    });
    const result = await forwarder.decide("cap-1", "team:t1:m1", 1, "adopted");
    assert.equal(result.delivered, true);
    // 送达成功分支：forwarder 不越权删除——落表项由 createLocalGateway 的 resolveApproval 收口，
    // 分界清晰（delete 幂等所以重复删除无害，但职责单一化更可审计）。
    assert.equal(db.hasPendingApproval("team:t1:m1"), true);
  } finally {
    db.close();
  }
});
