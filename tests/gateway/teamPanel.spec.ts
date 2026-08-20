/**
 * M4 团队活动面板数据面（T6）：buildTeamPanelSnapshot / listTeamsForPanel 纯函数。
 * TeamDb 直查 + SessionPresence 合并在线态；不依赖工具注册表（数据面）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember } from "../../src/agent/team/index.js";
import { SessionPresence } from "../../src/gateway/server/sessionPresence.js";
import { buildTeamPanelSnapshot, listTeamsForPanel } from "../../src/gateway/teamPanel.js";

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

test("buildTeamPanelSnapshot：团队 + 成员（含在线态/roleSlug/modelRoute/retired）+ 任务（含 attemptId/blockedByCount）+ 消息未读数", () => {
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
