import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TeamDb,
  createTeamMember,
  type TeamEvent,
  type TeamEventEmitter,
  type TeamScheduler,
} from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import { createTeamSendMessageTool, createTeamStatusTool } from "../../../../src/tool/builtin/team/index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-team-mailbox-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const kicked: string[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {
    kickMember: async (_teamId: string, memberId: string) => {
      kicked.push(memberId);
    },
    onTaskGraphChanged: async () => {},
  } as unknown as TeamScheduler;
  const tools = {
    sendMessage: createTeamSendMessageTool({ db, scheduler, emit }),
    status: createTeamStatusTool({ db, scheduler, emit }),
  };
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  return { db, events, kicked, tools };
}

test("team_send_message：captain 投递 + 落库 + kickMember（事件由 scheduler ack 路径发）", async () => {
  const { db, events, kicked, tools } = setup();
  const out = await tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "请核实对比文件 D2" }, {
    sessionId: "cap-1",
  } as never);
  const data = out.data as { messageId: string };
  assert.equal(typeof data.messageId, "string", "返回 messageId（msg- 前缀）");
  const msgs = db.listMessages("t1", "m1");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.sender, "captain");
  assert.equal(msgs[0]!.recipient, "m1");
  assert.equal(msgs[0]!.content, "请核实对比文件 D2");
  assert.ok(kicked.includes("m1"), "投递后应触发成员唤醒（邮箱优先路径）");
  assert.equal(events.length, 0, "message_delivered 由 scheduler ack 路径发出，send_message 不 emit（单事件语义）");
});

test("team_send_message：成员互发（sender=memberId）；空内容/畸形会话/未知团队/未知收件人/退休收件人拒绝", async () => {
  const { db, tools } = setup();
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m2",
    roleSlug: "drafter",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  await tools.sendMessage.execute({ teamId: "t1", recipient: "m2", content: "从权 2 的表述" }, {
    sessionId: "team:t1:m1",
  } as never);
  const msgs = db.listMessages("t1", "m2");
  assert.equal(msgs[0]!.sender, "m1");

  // 空内容/纯空白拒绝（锁外输入校验，M5 风格）
  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "invalid_tool_input",
  );
  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "   " }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "invalid_tool_input",
  );
  // 畸形成员会话（team:t1:）fail-closed：不得按 captain 放行（否则 sender 审计失真为 "captain"）
  await assert.rejects(
    () =>
      tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "x" }, { sessionId: "team:t1:" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_actor_unknown",
  );
  await assert.rejects(
    () =>
      tools.sendMessage.execute({ teamId: "no-such", recipient: "m1", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  await assert.rejects(
    () =>
      tools.sendMessage.execute({ teamId: "t1", recipient: "no-such", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
  db.insertRetired(db.getMember("m2")!.sessionKey, "m2", "test");
  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "t1", recipient: "m2", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_member_retired",
  );
});

test("归档后只读：team_send_message（队长路径）报 team_already_archived（T8 review F4）", async () => {
  const { db, kicked, tools } = setup();
  db.archiveTeam("t1", "2026-08-20T00:00:00.000Z");
  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_already_archived",
  );
  assert.equal(db.listMessages("t1", "m1").length, 0, "门禁拒绝不落库");
  assert.equal(kicked.length, 0, "门禁拒绝不触发唤醒");
  // 成员路径：正常归档使成员全退休，由 requireTeamMember 的 team_member_retired 天然挡住（F4 无需重复门禁）
  db.insertRetired(db.getMember("m1")!.sessionKey, "m1", "team_archived");
  await assert.rejects(
    () =>
      tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "x" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_member_retired",
  );
});

test("跨队成员会话（team:t2:x）调 t1 的 send_message / status → team_not_member", async () => {
  const { db, tools } = setup();
  // 另建 t2 团队 + x 成员：跨队成员会话是 requireTeamMember 的核心负路径
  db.upsertTeam({ id: "t2", name: "t2", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t2",
    memberId: "x",
    roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  await assert.rejects(
    () =>
      tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "x" }, { sessionId: "team:t2:x" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
  await assert.rejects(
    () => tools.status.execute({ teamId: "t1" }, { sessionId: "team:t2:x" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
});

test("team_status：三视图只读（脏数据降级/任务含 attemptId+handoffId+output/空团队/畸形会话）", async () => {
  const { db, tools } = setup();
  // 脏数据成员：modelRouteJson 非法 → 视图降级为空对象（对齐 scheduler 损坏行跳过语义，过 outputSchema object 校验）
  db.insertMember({
    id: "m-bad",
    teamId: "t1",
    roleSlug: "researcher",
    modelRouteJson: "{broken-json",
    status: "idle",
    sessionKey: "team:t1:m-bad",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  db.insertTask({
    id: "a",
    teamId: "t1",
    subject: "A",
    description: "",
    status: "claimed",
    assigneeId: "m1",
    dependencies: [],
    attempt: 1,
    attemptId: "attempt-1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    handoffId: "handoff-1",
    output: "中间输出",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  const out = await tools.status.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never);
  const data = out.data as {
    team: { id: string; name: string };
    members: Array<{ memberId: string; roleSlug: string; status: string; modelRoute: unknown; retired: boolean }>;
    tasks: Array<{
      taskId: string;
      status: string;
      attempt: number;
      assigneeId?: string;
      attemptId?: string;
      blockedByCount: number;
      handoffId?: string;
      output?: string;
    }>;
  };
  assert.equal(data.team.id, "t1");
  assert.equal(data.members.length, 2, "含脏数据成员 m-bad");
  const m1 = data.members.find(m => m.memberId === "m1")!;
  assert.equal(m1.roleSlug, "researcher");
  assert.equal(m1.retired, false);
  assert.deepEqual(m1.modelRoute, { provider: "fake", model: "fake-model" });
  const mBad = data.members.find(m => m.memberId === "m-bad")!;
  assert.deepEqual(mBad.modelRoute, {}, "modelRouteJson 解析失败降级为空对象");
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0]!.status, "claimed");
  assert.equal(
    data.tasks[0]!.attemptId,
    "attempt-1",
    "任务视图含 attemptId（队长取消进行中任务需要它，status 是唯一持久视图）",
  );
  assert.equal(data.tasks[0]!.blockedByCount, 0);
  assert.equal(data.tasks[0]!.handoffId, "handoff-1");
  assert.equal(data.tasks[0]!.output, "中间输出");

  // 未知团队拒绝
  await assert.rejects(
    () => tools.status.execute({ teamId: "no-such" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  // 空团队视图：无成员/无任务
  db.upsertTeam({ id: "t2", name: "t2", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  const empty = await tools.status.execute({ teamId: "t2" }, { sessionId: "cap-2" } as never);
  const emptyData = empty.data as { members: unknown[]; tasks: unknown[] };
  assert.deepEqual(emptyData.members, []);
  assert.deepEqual(emptyData.tasks, []);
  // 成员可查（作业面）+ 内容断言（非仅 team.id）
  const memberView = await tools.status.execute({ teamId: "t1" }, { sessionId: "team:t1:m1" } as never);
  const mv = memberView.data as { team: { id: string }; members: Array<{ memberId: string; roleSlug: string }> };
  assert.equal(mv.team.id, "t1");
  assert.ok(
    mv.members.some(m => m.memberId === "m1" && m.roleSlug === "researcher"),
    "成员视图返回成员列表",
  );
  // 畸形成员会话（team:t1:）fail-closed
  await assert.rejects(
    () => tools.status.execute({ teamId: "t1" }, { sessionId: "team:t1:" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_actor_unknown",
  );
});
