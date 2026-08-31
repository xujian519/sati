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
import { registerRoleDefinition, unregisterRoleDefinition } from "../../../../src/agent/sub/builtinSubagentTypes.js";
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

test("归档后只读：create_task / update_task（队长路径）/ reassign 报 team_already_archived（T8 review F4）", async () => {
  const { db, tools, insertTask } = setup();
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
  db.archiveTeam("t1", "2026-08-20T00:00:00.000Z");
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_already_archived",
  );
  // update_task 队长路径（成员路径已因全员退休被 team_member_retired 天然挡住，不在此测）
  await assert.rejects(
    () =>
      tools.updateTask.execute(
        { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1", output: "x" },
        { sessionId: "cap-1" } as never,
      ),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_already_archived",
  );
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m1" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_already_archived",
  );
  const task = db.getTask("t1", "a")!;
  assert.equal(task.status, "claimed", "门禁拒绝不产生任何副作用");
  assert.equal(task.attempt, 1);
  assert.equal(db.listTasks("t1").length, 1, "未新建任务");
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

test("team_reassign_task：幽灵/他队/退休成员拒绝（I1），校验不落盘", async () => {
  const { db, tools, insertTask } = setup();
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
  db.upsertTeam({ id: "t2", name: "t2", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t2",
    memberId: "m-x",
    roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  db.insertRetired(db.getMember("m2")!.sessionKey, "m2", "test-retired");
  // 幽灵成员（不存在）→ team_not_member
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "no-such" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
  // 他队成员（m-x 属于 t2）→ team_not_member
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m-x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
  // 退休成员（m2）→ team_member_retired
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_member_retired",
  );
  // 校验失败不落盘：任务保持原样（attemptId 未失效）
  const task = db.getTask("t1", "a")!;
  assert.equal(task.status, "claimed");
  assert.equal(task.assigneeId, "m1");
  assert.equal(task.attemptId, "attempt-1");
});

test("team_update_task：队长取消 pending 任务豁免 attemptId 校验（I2），成员路径仍 fail-closed", async () => {
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
  insertTask({
    id: "c",
    teamId: "t1",
    subject: "C",
    description: "",
    status: "pending",
    assigneeId: "m1",
    dependencies: [],
    attempt: 0,
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
  });
  // 队长取消 blocked 任务：pending 任务无 attemptId，豁免校验（attemptId 传任意值）
  await tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "cancelled", attemptId: "stale-any" }, {
    sessionId: "cap-1",
  } as never);
  const a = db.getTask("t1", "a")!;
  assert.equal(a.status, "cancelled");
  assert.ok(events.some(e => e.type === "task_updated" && e.taskId === "a" && e.status === "cancelled"));
  // 注意：unsatisfiedDependencies 只认 completed——cancelled 不等于完成，下游 b 仍阻塞（M2 语义）
  const b = db.getTask("t1", "b")!;
  assert.equal(b.blockedByCount, 1, "cancelled ≠ completed：下游依赖仍未满足");
  // 成员路径不豁免：名下 pending 任务取消 → attemptId 恒缺失 → stale_attempt
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "c", status: "cancelled", attemptId: "stale-any" }, {
        sessionId: "team:t1:m1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
});

test("team_update_task：队长对 claimed 任务取消不豁免 attemptId（I2 边界：非 pending 不豁免）", async () => {
  const { db, tools, insertTask } = setup();
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
  // claimed 任务已有 attempt 语义：即使目标是 cancelled、调用者是队长，错误 attemptId 仍 fail-closed
  await assert.rejects(
    () =>
      tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "cancelled", attemptId: "wrong-attempt" }, {
        sessionId: "cap-1",
      } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // 正确 attemptId 可取消（对照：claimed → cancelled 合法，且校验通过）
  await tools.updateTask.execute({ teamId: "t1", taskId: "a", status: "cancelled", attemptId: "attempt-1" }, {
    sessionId: "cap-1",
  } as never);
  assert.equal(db.getTask("t1", "a")!.status, "cancelled");
});

test("team_update_task：成员失败 → failed + attemptId 保留 + task_failed 事件 + output 清空（M6/M7）", async () => {
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
    output: "旧输出",
  });
  await tools.updateTask.execute(
    { teamId: "t1", taskId: "a", status: "failed", attemptId: "attempt-1", reason: "超时" },
    { sessionId: "team:t1:m1" } as never,
  );
  const a = db.getTask("t1", "a")!;
  assert.equal(a.status, "failed");
  assert.equal(a.attemptId, "attempt-1", "终态保留 attemptId（队长可审计）");
  assert.equal(a.output, undefined, "M7：非 completed 终态清 output");
  assert.ok(events.some(e => e.type === "task_failed" && e.taskId === "a" && e.reason === "超时"));
});

test("team_create_task：subject 空白 / maxAttempts 非法拒绝（M5）", async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "  " }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "invalid_tool_input",
  );
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X", maxAttempts: 0 }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "invalid_tool_input",
  );
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X", maxAttempts: 2.5 }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "invalid_tool_input",
  );
});

test("team_update_task：成员完成按角色 outputSchema 校验——缺字段降级提示、不硬失败（P0-2）", async () => {
  const { db, events, tools, insertTask } = setup();
  registerRoleDefinition({
    id: "researcher",
    description: "检索",
    allowedTools: ["*"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix: "",
    outputSchema: { type: "object", properties: {}, required: ["新颖性结论", "证据"] },
  });
  try {
    // 缺字段：output 未含必要字段 → text 附 [输出契约]
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
    const out = await tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1", output: "结论未结构化" },
      { sessionId: "team:t1:m1" } as never,
    );
    // 不硬失败：任务已终态、output 原样保留、task_completed 事件照发
    const a = db.getTask("t1", "a")!;
    assert.equal(a.status, "completed");
    assert.equal(a.output, "结论未结构化");
    assert.ok(events.some(e => e.type === "task_completed" && e.taskId === "a"));
    const text = out.content.map(c => (c.type === "text" ? c.text : "")).join("");
    assert.ok(text.includes("[输出契约]"), "缺字段应附输出契约提示");
    assert.ok(text.includes("新颖性结论"), "应提示缺新颖性结论");
    assert.ok(text.includes("证据"), "应提示缺证据");

    // 字段齐全：子串命中全部 required → 不附 [输出契约]
    insertTask({
      id: "b",
      teamId: "t1",
      subject: "B",
      description: "",
      status: "in_progress",
      assigneeId: "m1",
      dependencies: [],
      attempt: 1,
      attemptId: "attempt-2",
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
    });
    const out2 = await tools.updateTask.execute(
      {
        teamId: "t1",
        taskId: "b",
        status: "completed",
        attemptId: "attempt-2",
        output: "新颖性结论：有新颖性，证据：对比文件1",
      },
      { sessionId: "team:t1:m1" } as never,
    );
    const text2 = out2.content.map(c => (c.type === "text" ? c.text : "")).join("");
    assert.ok(!text2.includes("[输出契约]"), "字段齐全不应附输出契约提示");
  } finally {
    unregisterRoleDefinition("researcher");
  }
});

test("team_update_task：队长代操作无角色 outputSchema —— 不触发输出契约校验（P0-2 成员专属）", async () => {
  const { db, tools, insertTask } = setup();
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
  // 队长路径 memberId === undefined → 跳过 schema 校验，缺字段也不报
  const out = await tools.updateTask.execute(
    { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1", output: "无结构" },
    { sessionId: "cap-1" } as never,
  );
  const text = out.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.ok(!text.includes("[输出契约]"), "队长路径不校验角色输出契约");
  assert.equal(db.getTask("t1", "a")!.status, "completed");
});

test("team_update_task：outputSchema 纯 ASCII 短字段名跳过子串检查（防 id 误报，P0-2）", async () => {
  const { tools, insertTask } = setup();
  registerRoleDefinition({
    id: "researcher",
    description: "检索",
    allowedTools: ["*"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix: "",
    outputSchema: { type: "object", properties: {}, required: ["id", "conclusion"] },
  });
  try {
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
    // output 为自由文本："id" 是纯 ASCII 短 token（子串歧义大）→ 跳过不报缺；"conclusion" 仍检查
    const out = await tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1", output: "no structured result here" },
      { sessionId: "team:t1:m1" } as never,
    );
    const text = out.content.map(c => (c.type === "text" ? c.text : "")).join("");
    assert.ok(text.includes("conclusion"), "应提示缺 conclusion");
    assert.ok(!text.includes("缺关键字段：id"), "纯 ASCII 短 token（id）跳过子串检查，不误报缺 id");
  } finally {
    unregisterRoleDefinition("researcher");
  }
});
