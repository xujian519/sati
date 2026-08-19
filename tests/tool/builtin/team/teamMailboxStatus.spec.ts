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

test("team_send_message：captain 投递 + 落库 + message_delivered + kickMember", async () => {
  const { db, events, kicked, tools } = setup();
  const out = await tools.sendMessage.execute({ teamId: "t1", recipient: "m1", content: "请核实对比文件 D2" }, {
    sessionId: "cap-1",
  } as never);
  const data = out.data as { messageId: string };
  const msgs = db.listMessages("t1", "m1");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.sender, "captain");
  assert.equal(msgs[0]!.recipient, "m1");
  assert.equal(msgs[0]!.content, "请核实对比文件 D2");
  assert.ok(events.some(e => e.type === "message_delivered" && e.recipient === "m1"));
  assert.ok(kicked.includes("m1"), "投递后应触发成员唤醒（邮箱优先路径）");
});

test("team_send_message：成员互发（sender=memberId）；未知团队/未知收件人/退休收件人拒绝", async () => {
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

test("team_status：三视图只读（团队/成员含 roleSlug+modelRoute+retired/任务含 blockedByCount+handoffId）", async () => {
  const { db, tools } = setup();
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
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  const out = await tools.status.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never);
  const data = out.data as {
    team: { id: string; name: string };
    members: Array<{ memberId: string; roleSlug: string; status: string; modelRoute: unknown; retired: boolean }>;
    tasks: Array<{ taskId: string; status: string; attempt: number; assigneeId?: string; blockedByCount: number }>;
  };
  assert.equal(data.team.id, "t1");
  assert.equal(data.members.length, 1);
  assert.equal(data.members[0]!.roleSlug, "researcher");
  assert.equal(data.members[0]!.retired, false);
  assert.deepEqual(data.members[0]!.modelRoute, { provider: "fake", model: "fake-model" });
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0]!.status, "claimed");
  assert.equal(data.tasks[0]!.blockedByCount, 0);

  await assert.rejects(
    () => tools.status.execute({ teamId: "no-such" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  const memberView = await tools.status.execute({ teamId: "t1" }, { sessionId: "team:t1:m1" } as never);
  assert.equal((memberView.data as { team: { id: string } }).team.id, "t1");
});
