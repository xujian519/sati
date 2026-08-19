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
  type TeamTaskRow,
} from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import {
  createTeamCreateTaskTool,
  createTeamUpdateTaskTool,
  createTeamReassignTaskTool,
} from "../../../../src/tool/builtin/team/index.js";

/** 测试 fixture：真实 TeamDb + 记录事件的伪调度器（kickMember 同步记录，便于断言派发触发）。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-team-tasks-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const kicked: string[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {
    onTaskGraphChanged: async () => {},
    kickMember: async (_teamId: string, memberId: string) => {
      kicked.push(memberId);
    },
  } as unknown as TeamScheduler;
  const tools = {
    createTask: createTeamCreateTaskTool({ db, scheduler, emit }),
    updateTask: createTeamUpdateTaskTool({ db, scheduler, emit }),
    reassign: createTeamReassignTaskTool({ db, scheduler, emit }),
  };
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m2",
    roleSlug: "drafter",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  const insertTask = (row: Omit<TeamTaskRow, "createdAt" | "updatedAt">) =>
    db.insertTask({ ...row, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
  return { root, db, events, kicked, tools, insertTask };
}

test("team_create_task：建任务 + blockedByCount 按依赖重算 + task_created 事件", async () => {
  const { db, events, tools, insertTask } = setup();
  insertTask({
    id: "a",
    teamId: "t1",
    subject: "A",
    description: "",
    status: "pending",
    dependencies: [],
    attempt: 0,
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
  });
  const out = await tools.createTask.execute(
    { teamId: "t1", subject: "B", description: "desc", dependencies: ["a"], maxAttempts: 5 },
    { sessionId: "cap-1" } as never,
  );
  const data = out.data as { taskId: string; blockedByCount: number };
  const task = db.getTask("t1", data.taskId)!;
  assert.equal(task.subject, "B");
  assert.equal(task.blockedByCount, 1, "依赖 a 未完成 → 阻塞 1");
  assert.equal(task.maxAttempts, 5);
  assert.equal(task.status, "pending");
  assert.ok(events.some(e => e.type === "task_created" && e.taskId === data.taskId));
});

test("team_create_task：依赖不存在拒绝；未知团队拒绝；成员会话拒绝", async () => {
  const { tools } = setup();
  await assert.rejects(
    () =>
      tools.createTask.execute({ teamId: "t1", subject: "X", dependencies: ["no-such"] }, {
        sessionId: "cap-1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_task_not_found",
  );
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "no-such", subject: "X" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_update_task：成员完成名下任务 → 终态 + attemptId 保留 + 下游 blockedByCount 重算", async () => {
  const { db, events, tools, insertTask } = setup();
  insertTask({
    id: "a",
    teamId: "t1",
    subject: "A",
    description: "",
    status: "in_progress",
    assigneeId: "m1",
    dependencies: [],
    attempt: 1,
    attemptId: "attempt-1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
  });
  insertTask({
    id: "b",
    teamId: "t1",
    subject: "B",
    description: "",
    status: "pending",
    dependencies: ["a"],
    attempt: 0,
    reassigning: false,
    blockedByCount: 1,
    maxAttempts: 3,
  });
  await tools.updateTask.execute(
    { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1", output: "结果" },
    { sessionId: "team:t1:m1" } as never,
  );
  const a = db.getTask("t1", "a")!;
  assert.equal(a.status, "completed");
  assert.equal(a.output, "结果");
  assert.equal(a.attemptId, "attempt-1", "终态保留 attemptId（队长可审计）");
  const b = db.getTask("t1", "b")!;
  assert.equal(b.blockedByCount, 0, "依赖 a 已完成 → 解锁");
  assert.ok(events.some(e => e.type === "task_completed" && e.taskId === "a" && e.output === "结果"));
});

test("team_update_task：非本人任务/队长代操作/stale-attempt/非法转移拒绝", async () => {
  const { tools, insertTask } = setup();
  insertTask({
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
  });
  // 非 assignee 成员拒绝
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1" }, {
        sessionId: "team:t1:m2",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_assignee",
  );
  // captain 可代操作（跳过成员校验，attemptId 仍校验）
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "completed", attemptId: "wrong-attempt" }, {
        sessionId: "cap-1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // stale-attempt（成员：attemptId 不匹配）
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "completed", attemptId: "old-attempt" }, {
        sessionId: "team:t1:m1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // 非法状态转移（claimed → pending 非法，TASK_TRANSITIONS 白名单；status 类型收敛为终态，测试直传原始值）
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "pending" as never, attemptId: "attempt-1" }, {
        sessionId: "team:t1:m1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_bad_transition",
  );
  // claimed → cancelled 合法；终态后任何 attemptId 拒绝（stale-attempt）
  await assert.rejects(
    () =>
      tools.updateTask
        .execute({ teamId: "t1", taskId: "a", status: "cancelled", attemptId: "attempt-1" }, {
          sessionId: "team:t1:m1",
        } as never)
        .then(() =>
          tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1" }, {
            sessionId: "team:t1:m1",
          } as never),
        ),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // 终态不可再写（completed 后任何 attemptId 拒绝）
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "failed", attemptId: "attempt-1" }, {
        sessionId: "team:t1:m1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
});

test("team_reassign_task：指定成员 → pending+assignee+reassigning:false → kickMember；回池 → reassigning:true 不派", async () => {
  const { db, events, kicked, tools, insertTask } = setup();
  insertTask({
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
  });
  await tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "cap-1" } as never);
  const a1 = db.getTask("t1", "a")!;
  assert.equal(a1.status, "pending");
  assert.equal(a1.assigneeId, "m2");
  assert.equal(a1.reassigning, false, "指定成员 → 可被 nextReadyTask 命中");
  assert.equal(a1.attemptId, undefined, "attemptId 已清（新 attempt 生效前旧写被拒）");
  assert.ok(a1.handoffId !== undefined && a1.handoffId !== a1.attemptId);
  assert.ok(events.some(e => e.type === "task_reassigned" && e.toMemberId === "m2"));
  assert.ok(kicked.includes("m2"), "指定成员应被 kickMember");
  await tools.reassign.execute({ teamId: "t1", taskId: "a" }, { sessionId: "cap-1" } as never);
  const a2 = db.getTask("t1", "a")!;
  assert.equal(a2.reassigning, true, "回池暂缓自动派发");
  assert.equal(a2.assigneeId, undefined);
});

test("team_reassign_task：终态任务拒绝；成员会话拒绝", async () => {
  const { tools, insertTask } = setup();
  insertTask({
    id: "a",
    teamId: "t1",
    subject: "A",
    description: "",
    status: "completed",
    assigneeId: "m1",
    dependencies: [],
    attempt: 1,
    attemptId: "attempt-1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
  });
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_task_terminal",
  );
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_create_task：非本队队长（cap-b）拒绝（T5 同队校验）", async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X" }, { sessionId: "cap-b" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_update_task：非本队 captain 代操作拒绝（T5 同队校验）", async () => {
  const { tools, insertTask } = setup();
  insertTask({
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
  });
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1" }, {
        sessionId: "cap-b",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_reassign_task：非本队队长（cap-b）拒绝（T5 同队校验）", async () => {
  const { tools, insertTask } = setup();
  insertTask({
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
  });
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "cap-b" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});
