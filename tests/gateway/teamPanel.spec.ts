/**
 * M4 团队活动面板数据面（T6）：buildTeamPanelSnapshot / listTeamsForPanel 纯函数。
 * TeamDb 直查 + SessionPresence 合并在线态；不依赖工具注册表（数据面）。
 * T6 评审补强（M4）：多团队聚合隔离、快照自身 archivedAt 透出、未读数（F1 公式）、
 * teamToolCall 接线错误码分支（前缀白名单/未知工具/SatiToolRuntimeError 透传/fail-closed）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember } from "../../src/agent/team/index.js";
import { SessionPresence } from "../../src/gateway/server/sessionPresence.js";
import { buildTeamPanelSnapshot, listTeamsForPanel } from "../../src/gateway/teamPanel.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-panel-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "调研组", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "p", model: "m" },
  });
  db.insertTask({
    id: "a",
    teamId: "t1",
    subject: "A",
    description: "",
    status: "pending",
    assigneeId: undefined,
    dependencies: [],
    attempt: 0,
    attemptId: undefined,
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  return { db };
}

test("buildTeamPanelSnapshot：团队 + 成员（含在线态/roleSlug/modelRoute/retired）+ 任务（含 attemptId/blockedByCount）", () => {
  const { db } = setup();
  const presence = new SessionPresence();
  const now = 1_000_000;
  presence.touch("cap-1", now); // 队长直连在线
  const snap = buildTeamPanelSnapshot(db, presence, now);
  assert.equal(snap.teams.length, 1);
  const team = snap.teams[0]!;
  assert.equal(team.id, "t1");
  assert.equal(team.captainOnline, true, "presence 合并：队长在线");
  assert.equal(team.members.length, 1);
  assert.equal(team.members[0]!.memberId, "m1");
  assert.equal(team.members[0]!.roleSlug, "researcher");
  assert.equal(team.members[0]!.status, "idle", "成员 status 透出");
  assert.equal(team.members[0]!.modelRoute.provider, "p");
  assert.equal(team.members[0]!.retired, false);
  assert.equal(team.tasks.length, 1);
  assert.equal(team.tasks[0]!.taskId, "a");
  assert.equal(team.tasks[0]!.blockedByCount, 0);
  // 离线队长：presence.close 超宽限窗
  presence.close("cap-1", now);
  const snap2 = buildTeamPanelSnapshot(db, presence, now + 70_000);
  assert.equal(snap2.teams[0]!.captainOnline, false, "直连关闭超宽限窗 → 离线");
});

test('unreadForCaptain：recipient="captain" 未投递计数，已投递不计（F1 公式对齐存储约定）', () => {
  const { db } = setup();
  const presence = new SessionPresence();
  const createdAt = "2026-08-20T00:00:00.000Z";
  // insertMessage 忽略投递状态列（由 updateMessage 生命周期管理），未投递 = 仅 insert
  db.insertMessage({ id: "m1", teamId: "t1", sender: "m1", recipient: "captain", content: "检索完成报告", createdAt });
  // 已投递 = insert 后 updateMessage 置 deliveredAt
  db.insertMessage({
    id: "m2",
    teamId: "t1",
    sender: "m1",
    recipient: "captain",
    content: "已读过的旧消息",
    createdAt,
  });
  db.updateMessage({
    id: "m2",
    teamId: "t1",
    sender: "m1",
    recipient: "captain",
    content: "x",
    createdAt,
    deliveredAt: "2026-08-20T00:05:00.000Z",
  });
  // 异队收件人（非 captain）不计入本队队长收件箱
  db.insertMessage({ id: "m3", teamId: "t1", sender: "m1", recipient: "m1", content: "成员间消息", createdAt });
  const snap = buildTeamPanelSnapshot(db, presence, 1_000_000);
  assert.equal(snap.teams[0]!.unreadForCaptain, 1, "仅 recipient=captain 且未投递计数");
});

test("多团队聚合隔离：成员/任务/未读数互不串，status 与 archivedAt 透出", () => {
  const { db } = setup();
  // t2：独立成员（working 态）+ 任务 + 归档
  db.upsertTeam({ id: "t2", name: "撰写组", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t2",
    memberId: "m2",
    roleSlug: "drafter",
    modelRoute: { provider: "p2", model: "m2" },
  });
  db.updateMemberStatus("m2", "working");
  db.insertTask({
    id: "b",
    teamId: "t2",
    subject: "B",
    description: "",
    status: "in_progress",
    assigneeId: "m2",
    dependencies: [],
    attempt: 1,
    attemptId: "att-1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  db.insertMessage({
    id: "m1",
    teamId: "t2",
    sender: "m2",
    recipient: "captain",
    content: "t2 未读",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(db.archiveTeam("t2", "2026-08-20T00:00:00.000Z"), true, "t2 归档");

  const snap = buildTeamPanelSnapshot(db, new SessionPresence(), 1_000_000);
  assert.equal(snap.teams.length, 2);
  const t1 = snap.teams.find(t => t.id === "t1")!;
  const t2 = snap.teams.find(t => t.id === "t2")!;
  // 聚合隔离：t1 只见自己的成员与任务
  assert.equal(t1.members.length, 1);
  assert.equal(t1.members[0]!.memberId, "m1");
  assert.equal(t1.tasks.length, 1);
  assert.equal(t1.tasks[0]!.taskId, "a");
  assert.equal(t1.unreadForCaptain, 0);
  // t2：成员 status/attemptId 透出、未读数 1、archivedAt 透出（快照自身，非仅 listTeamsForPanel）
  assert.equal(t2.members.length, 1);
  assert.equal(t2.members[0]!.memberId, "m2");
  assert.equal(t2.members[0]!.status, "working", "成员 working 态透出");
  assert.equal(t2.tasks.length, 1);
  assert.equal(t2.tasks[0]!.taskId, "b");
  assert.equal(t2.tasks[0]!.status, "in_progress");
  assert.equal(t2.tasks[0]!.attemptId, "att-1");
  assert.equal(t2.unreadForCaptain, 1, "t2 队长未读独立计数");
  assert.equal(t2.archivedAt, "2026-08-20T00:00:00.000Z", "快照自身透出 archivedAt");
  assert.equal(t1.archivedAt, undefined, "未归档团队不含 archivedAt");
});

test("listTeamsForPanel：含归档态（archivedAt）与无队团队", () => {
  const { db } = setup();
  // upsertTeam 的 SQL 不含 archived_at 列（归档不可逆，仅经 archiveTeam 置位）——
  // 与 TeamDb 实际 API 对齐（计划假设 upsertTeam 可写 archivedAt，实际不写）。
  db.upsertTeam({ id: "t2", name: "已归档", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  assert.equal(db.archiveTeam("t2", "2026-08-20T00:00:00.000Z"), true, "archiveTeam 置位生效");
  const teams = listTeamsForPanel(db);
  assert.equal(teams.length, 2);
  assert.equal(teams.find(t => t.id === "t2")!.archivedAt, "2026-08-20T00:00:00.000Z");
});

test("teamToolCall 接线：前缀白名单 fail-closed + 未知工具 + SatiToolRuntimeError 透传 + 缺 sessionKey 需队长工具拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-panel-gw-"));
  // createLocalGateway 对空目录启动要求 config 含 agent/model 段（缺失为致命诊断），
  // 写最小 sati.yaml 满足合法性；真实模型层被 __testModelFactory 替换（参考 team-gateway-integration.spec.ts）。
  await writeFile(
    join(root, "sati.yaml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: deepseek/deepseek-v4-flash",
      "model:",
      "  providers:",
      "    deepseek:",
      "      apiKey: test-key",
      "      models:",
      "        deepseek-v4-flash: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    // 隔离外部环境（SATI_TEAMS_DB 等）：teams.db 必须落在 mkdtemp 临时目录内
    env: {},
    __testModelFactory: (): ModelRuntime => ({
      stream: async function* () {
        yield { type: "text_delta", text: "ok" };
      },
      complete: async () => {
        throw new Error("unused");
      },
      getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
      getMultimodal: () => ({ input: ["text"] }),
      getProviderProtocol: () => undefined,
      getProviderBaseUrl: () => undefined,
    }),
  });
  try {
    await result.teamSubsystem.startupScanDone;
    result.teamSubsystem.db.upsertTeam({
      id: "t1",
      name: "调研组",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    const gw = result.gateway;
    // 非 team_ 前缀 → fail-closed（M1 白名单，直调通道只暴露 team_* 域）
    const nonTeam = await gw.teamToolCall!({ tool: "bash", input: {} });
    assert.equal(nonTeam.ok, false);
    assert.equal(nonTeam.error?.code, "team_unknown_tool", "非 team_ 前缀拒绝");
    // 未知 team_ 工具 → 未注册
    const unknown = await gw.teamToolCall!({ tool: "team_ghost", input: {} });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.code, "team_unknown_tool", "未知 team_ 工具拒绝");
    // SatiToolRuntimeError code 透传：team_send_message 给不存在团队 → team_not_found
    const send = await gw.teamToolCall!({
      tool: "team_send_message",
      input: { teamId: "nope", recipient: "m1", content: "hi" },
    });
    assert.equal(send.ok, false);
    assert.equal(send.error?.code, "team_not_found", "SatiToolRuntimeError code 透传");
    // 缺省 sessionKey 调需队长工具 → fail-closed：空串非成员形态被 resolveActor 判为
    // captain:true，但同队校验（captainSessionKey !== ""）拒绝 → team_not_captain。
    const update = await gw.teamToolCall!({
      tool: "team_update_task",
      input: { teamId: "t1", taskId: "a", status: "cancelled" },
    });
    assert.equal(update.ok, false);
    assert.equal(update.error?.code, "team_not_captain", "缺 sessionKey 需队长工具 fail-closed（team_not_captain）");
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
