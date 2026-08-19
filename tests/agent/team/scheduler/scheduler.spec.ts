import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamDb, createTeamMember, TeamScheduler } from "../../../../src/agent/team/index.js";
import type { TeamEvent } from "../../../../src/agent/team/protocol/events.js";

type WakeRecord = { memberId: string; message: string };
type EmitRecord = { captain: string; event: TeamEvent };

async function setup(
  overrides: {
    maxConcurrentMembers?: number;
    isCaptainOnline?: () => boolean;
    wake?: (memberId: string, message: string) => Promise<boolean>;
  } = {},
): Promise<{ db: TeamDb; scheduler: TeamScheduler; wakes: WakeRecord[]; emits: EmitRecord[]; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sati-team-sched-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "p", model: "m" },
  });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m2",
    roleSlug: "drafter",
    modelRoute: { provider: "p", model: "m" },
  });
  const wakes: WakeRecord[] = [];
  const emits: EmitRecord[] = [];
  const scheduler = new TeamScheduler({
    db,
    emit: (captain, event) => {
      emits.push({ captain, event });
      return true;
    },
    wake: async (memberId, message) => {
      wakes.push({ memberId, message });
      return overrides.wake?.(memberId, message) ?? true;
    },
    maxConcurrentMembers: overrides.maxConcurrentMembers ?? 4,
    isCaptainOnline: overrides.isCaptainOnline ?? (() => true),
  });
  return { db, scheduler, wakes, emits, root };
}

test("kickTeam：依赖满足的 pending 任务派给未指派成员（邮箱优先于新任务）", async () => {
  const { db, scheduler, wakes, emits, root } = await setup();
  try {
    db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "检索",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.memberId, "m1");
    assert.match(wakes[0]?.message ?? "", /Attempt id:/);
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "claimed");
    assert.equal(task.assigneeId, "m1");
    assert.equal(task.attempt, 1);
    assert.ok(task.attemptId);
    assert.ok(emits.some(e => e.event.type === "task_claimed"));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("依赖未满足不认领；assignee 优先于未指派", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    const base = {
      teamId: "t1",
      subject: "x",
      description: "",
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: ["t1"] }); // 依赖未满足
    db.insertTask({ id: "t3", ...base, status: "pending", dependencies: [], assigneeId: "m2" }); // 指派 m2
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.memberId, "m2");
    assert.equal(db.getTask("t1", "t2")?.status, "pending");
    assert.equal(db.getTask("t1", "t3")?.status, "claimed");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("并发闸：working 成员数达上限不再派新任务（邮箱不受闸限仍投递）", async () => {
  const { db, scheduler, wakes, root } = await setup({ maxConcurrentMembers: 1 });
  try {
    const base = {
      teamId: "t1",
      subject: "x",
      description: "",
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    db.insertTask({ id: "t1", ...base, status: "pending", dependencies: [] });
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: [] });
    await scheduler.kickTeam("t1"); // m1 认领 t1，working=1 达上限
    assert.equal(wakes.length, 1);
    assert.equal(db.getTask("t1", "t2")?.status, "pending");
    // 再次触发：m2 的邮箱消息不受并发闸限制，仍应投递（但 t2 不派发）
    db.insertMessage({
      id: "mail",
      teamId: "t1",
      sender: "captain",
      recipient: "m2",
      content: "补充检索 D2 参数",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 2);
    assert.match(wakes[1]?.message ?? "", /补充检索 D2 参数/);
    assert.ok(db.listMessages("t1", "m2")[0]?.deliveredAt);
    assert.equal(db.getTask("t1", "t2")?.status, "pending"); // 闸限下 t2 仍 pending
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("唤醒失败回滚：只回滚自己的 ticket（attemptId 校验），成员回 idle", async () => {
  const { db, scheduler, root } = await setup({ wake: async () => false });
  try {
    db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "x",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickTeam("t1");
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "pending");
    assert.equal(task.attemptId, undefined);
    assert.equal(task.assigneeId, undefined);
    assert.equal(db.getMember("m1")?.status, "idle");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("邮箱优先：未读消息先投递（fallbackMailboxPrompt），投递成功才 ack", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    db.insertMessage({
      id: "m1",
      teamId: "t1",
      sender: "captain",
      recipient: "m1",
      content: "补充检索 D2 参数",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickMember("t1", "m1");
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]?.message ?? "", /补充检索 D2 参数/);
    assert.ok(db.listMessages("t1", "m1")[0]?.deliveredAt);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("邮箱唤醒失败：清 deliveryClaimedAt 释放租约（可重投）", async () => {
  const { db, scheduler, wakes, root } = await setup({ wake: async () => false });
  try {
    db.insertMessage({
      id: "m1",
      teamId: "t1",
      sender: "captain",
      recipient: "m1",
      content: "补充检索 D2 参数",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickMember("t1", "m1");
    const message = db.listMessages("t1", "m1")[0]!;
    assert.equal(wakes.length, 1);
    assert.equal(message.deliveredAt, undefined);
    assert.equal(message.deliveryClaimedAt, undefined); // 租约释放，可重投
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("唤醒失败且任务已被并发转派：不回滚他人 ticket，成员回 idle", async () => {
  const dbHolder: { db?: TeamDb } = {};
  const { db, scheduler, root } = await setup({
    wake: async () => {
      // 模拟 wake 挂起期间另一路径改写 attemptId（并发转派）
      const fresh = dbHolder.db!.getTask("t1", "t1")!;
      dbHolder.db!.updateTask({ ...fresh, attemptId: "other-attempt", updatedAt: "2026-08-20T00:00:01.000Z" });
      return false;
    },
  });
  dbHolder.db = db;
  try {
    db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "x",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickMember("t1", "m1");
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.attemptId, "other-attempt"); // 他人 ticket 未被回滚覆盖
    assert.equal(db.getMember("m1")?.status, "idle"); // 本成员从未真正开始回合，回 idle
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("队长离线：暂停认领（在途回合不派新任务）", async () => {
  const { db, scheduler, wakes, root } = await setup({ isCaptainOnline: () => false });
  try {
    db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "x",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 0);
    assert.equal(db.getTask("t1", "t1")?.status, "pending");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("归档团队：kickTeam/kickMember 跳过（有就绪任务 + idle 成员 → 不建 attempt、无 wake，T8 review F2a）", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "x",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    db.archiveTeam("t1", "2026-08-20T00:00:00.000Z");
    await scheduler.kickTeam("t1");
    await scheduler.kickMember("t1", "m1");
    assert.equal(wakes.length, 0, "归档团队不唤醒任何成员");
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "pending");
    assert.equal(task.attempt, 0, "未创建 attempt");
    assert.equal(task.assigneeId, undefined);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("归档团队：成员未退休也跳过 kickMember（钉住 archivedAt 检查本身而非退休副作用，T8 review F2b）", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "x",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    // 手工构造：仅归档、不退休成员（正常归档会全退休——此处隔离出 archivedAt 检查本身）
    db.archiveTeam("t1", "2026-08-20T00:00:00.000Z");
    assert.equal(db.isRetired(db.getMember("m1")!.sessionKey), false, "前置：成员未退休");
    await scheduler.kickMember("t1", "m1");
    assert.equal(wakes.length, 0, "archivedAt 置位即跳过，与成员退休与否无关");
    assert.equal(db.getTask("t1", "t1")?.status, "pending");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("onMemberIdle：成员完成依赖链首任务后 idle → 触发接手下一任务（member_idle 广播）", async () => {
  const { db, scheduler, wakes, emits, root } = await setup();
  try {
    const base = {
      teamId: "t1",
      subject: "x",
      description: "",
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    db.insertTask({ id: "t1", ...base, status: "pending", dependencies: [] });
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: ["t1"] }); // t2 依赖 t1，首轮无人可领
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 1); // 仅 m1 领到 t1
    // m1 完成 t1 后 idle → 调度器触发：t2 依赖解除，m1 接手
    const completed = db.getTask("t1", "t1")!;
    db.updateTask({ ...completed, status: "completed", updatedAt: "2026-08-20T00:00:01.000Z" });
    await scheduler.onMemberIdle("t1", "m1");
    assert.equal(wakes.length, 2);
    assert.equal(db.getTask("t1", "t2")?.status, "claimed");
    assert.equal(db.getTask("t1", "t2")?.assigneeId, "m1");
    assert.ok(emits.some(e => e.event.type === "member_idle"));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ownedOpenTask 优先：claimed/in_progress 且 assignee 成员的先重试（冷恢复语义）", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    const base = {
      teamId: "t1",
      subject: "x",
      description: "",
      attempt: 0,
      dependencies: [],
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    db.insertTask({ id: "t1", ...base, status: "claimed", assigneeId: "m1", attempt: 1, attemptId: "a1" });
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: [] });
    await scheduler.kickMember("t1", "m1");
    const task1 = db.getTask("t1", "t1")!;
    assert.equal(task1.attempt, 2);
    assert.notEqual(task1.attemptId, "a1");
    assert.equal(wakes[0]?.memberId, "m1");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
