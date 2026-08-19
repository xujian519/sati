/**
 * scanStrandedTasks：冷恢复（M2 扩展）——claimed/in_progress 但 assignee 成员 idle
 * （或成员不存在/已退休）的任务视为 stranded，invalidate 旧 attempt 后回调重新认领。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamDb, createTeamMember, scanStrandedTasks } from "../../../../src/agent/team/index.js";

test("stranded 任务（claimed/in_progress 但成员 idle）→ invalidate + re-claim 回调", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-stranded-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-retired",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    db.insertRetired("team:t1:m-retired", "m-retired", "removed");
    const base = {
      teamId: "t1",
      subject: "x",
      description: "",
      dependencies: [],
      attempt: 1,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    db.insertTask({ id: "t1", ...base, status: "claimed", assigneeId: "m1", attemptId: "a1" }); // 成员 idle + claimed → stranded
    db.insertTask({ id: "t2", ...base, status: "in_progress", assigneeId: "m1", attemptId: "a2" }); // 同上
    db.insertTask({ id: "t3", ...base, status: "claimed", assigneeId: "m2" }); // 成员不存在 → stranded
    db.insertTask({ id: "t4", ...base, status: "pending" }); // 非 open → 不动
    db.insertTask({ id: "t5", ...base, status: "claimed", assigneeId: "m-retired" }); // 成员已退休 → stranded
    db.insertTask({ id: "t6", ...base, status: "in_progress" }); // open 但无 assignee → 跳过
    const invalidated: string[] = [];
    const result = await scanStrandedTasks({
      db,
      invalidateAndKick: async (teamId, taskId, memberId) => {
        invalidated.push(`${teamId}:${taskId}:${memberId}`);
      },
    });
    assert.equal(result.stranded, 4);
    assert.deepEqual(invalidated.sort(), ["t1:t1:m1", "t1:t2:m1", "t1:t3:m2", "t1:t5:m-retired"]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("working 成员的名下任务不算 stranded（未中断）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-stranded-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    db.updateMemberStatus("m1", "working");
    const base = {
      teamId: "t1",
      subject: "x",
      description: "",
      dependencies: [],
      attempt: 1,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    db.insertTask({ id: "t1", ...base, status: "claimed", assigneeId: "m1", attemptId: "a1" });
    const invalidated: string[] = [];
    const result = await scanStrandedTasks({
      db,
      invalidateAndKick: async (teamId, taskId, memberId) => {
        invalidated.push(`${teamId}:${taskId}:${memberId}`);
      },
    });
    assert.equal(result.stranded, 0);
    assert.deepEqual(invalidated, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
