import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, type TeamEvent, type TeamEventEmitter } from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import {
  createTeamCreateTool,
  createTeamAddMemberTool,
  createTeamRemoveMemberTool,
} from "../../../../src/tool/builtin/team/index.js";
import { registerRoleDefinition, unregisterRoleDefinition } from "../../../../src/agent/sub/builtinSubagentTypes.js";
import { createTeamMember } from "../../../../src/agent/team/index.js";

/** 测试 fixture：真实 TeamDb + 记录事件的伪调度器。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-team-mgmt-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {
    onTaskGraphChanged: async () => {},
    onMemberIdle: async () => {},
    kickMember: async () => {},
  } as unknown as import("../../../../src/agent/team/index.js").TeamScheduler;
  const tools = {
    create: createTeamCreateTool({ db, scheduler, emit }),
    addMember: createTeamAddMemberTool({ db, scheduler, emit }),
    removeMember: createTeamRemoveMemberTool({ db, scheduler, emit }),
  };
  return { root, db, events, tools };
}

/** 注册测试角色（SubagentDefinition 实际形状：allowedTools/omitProjectInstructions/omitGitStatus/isReadOnly/systemPromptSuffix）。 */
function registerTestRole(id: string): void {
  registerRoleDefinition({
    id,
    description: "Test Role",
    allowedTools: [],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix: "test",
  });
}

test("team_create：建队 + 首批成员 + team_created/member_added 事件", async () => {
  const { db, events, tools } = setup();
  registerTestRole("test-researcher");
  try {
    const out = await tools.create.execute({ name: "专利团队", memberRoleSlugs: ["test-researcher"] }, {
      sessionId: "cap-1",
    } as never);
    const data = out.data as { teamId: string; captainSessionKey: string; members: Array<{ memberId: string }> };
    assert.match(data.teamId, /^t-/);
    assert.equal(data.captainSessionKey, "cap-1");
    assert.equal(data.members.length, 1);
    assert.ok(db.getTeam(data.teamId));
    assert.ok(db.getMember(data.members[0]!.memberId));
    assert.equal(events.filter(e => e.type === "team_created").length, 1);
    assert.equal(events.filter(e => e.type === "member_added").length, 1);
  } finally {
    unregisterRoleDefinition("test-researcher");
  }
});

test("team_create：未知 roleSlug 拒绝", async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.create.execute({ name: "t", memberRoleSlugs: ["no-such-role"] }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
  );
});

test("team_create：成员会话被拒（requireCaptain）", async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.create.execute({ name: "t" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_add_member：招募成员 + modelRoute 继承", async () => {
  const { db, events, tools } = setup();
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  registerTestRole("test-searcher");
  try {
    const out = await tools.addMember.execute({ teamId: "t1", roleSlug: "test-searcher" }, {
      sessionId: "cap-1",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    } as never);
    const data = out.data as { memberId: string };
    const member = db.getMember(data.memberId)!;
    assert.equal(member.roleSlug, "test-searcher");
    assert.equal(JSON.parse(member.modelRouteJson).provider, "deepseek");
    assert.ok(events.some(e => e.type === "member_added" && e.teamId === "t1"));
  } finally {
    unregisterRoleDefinition("test-searcher");
  }
});

test("team_add_member：未知团队/未知角色拒绝", async () => {
  const { db, tools } = setup();
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  registerTestRole("test-searcher");
  try {
    // 角色先校验（锁外静态）：未知角色不论团队是否存在都拒绝
    await assert.rejects(
      () => tools.addMember.execute({ teamId: "no-such", roleSlug: "no-such-role" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
    );
    // 团队存在性在锁内校验：角色已注册时未知团队拒绝
    await assert.rejects(
      () => tools.addMember.execute({ teamId: "no-such", roleSlug: "test-searcher" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
    );
    await assert.rejects(
      () => tools.addMember.execute({ teamId: "t1", roleSlug: "no-such-role" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
    );
  } finally {
    unregisterRoleDefinition("test-searcher");
  }
});

test("team_remove_member：退休 + 名下 open 任务 invalidate 回池 + member_removed", async () => {
  const { db, events, tools } = setup();
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "test-researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  db.insertTask({
    id: "task-1",
    teamId: "t1",
    subject: "s",
    description: "",
    status: "claimed",
    assigneeId: "m1",
    dependencies: [],
    attempt: 1,
    attemptId: "a1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  await tools.removeMember.execute({ teamId: "t1", memberId: "m1" }, { sessionId: "cap-1" } as never);
  assert.ok(db.isRetired(db.getMember("m1")!.sessionKey));
  const task = db.getTask("t1", "task-1")!;
  assert.equal(task.status, "pending");
  // invalidateTaskAttempt 未传 handoffId 时总是新铸一个（M2 语义：handoff 链标记），去向由队长 reassign 决定
  assert.ok(task.handoffId);
  assert.equal(task.reassigning, true); // 回池暂缓自动派发
  assert.ok(events.some(e => e.type === "member_removed" && e.memberId === "m1"));
});
