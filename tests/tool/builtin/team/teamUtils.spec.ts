import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember } from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import {
  parseTeamSessionKey,
  isCaptainSession,
  resolveActor,
  requireTeamMember,
  requireCaptain,
  requireRegisteredRole,
} from "../../../../src/tool/builtin/team/teamUtils.js";

test("parseTeamSessionKey：成员 key 解析；captain/非法 key 返回 undefined", () => {
  assert.deepEqual(parseTeamSessionKey("team:t1:m1"), { teamId: "t1", memberId: "m1" });
  assert.deepEqual(parseTeamSessionKey("team:t1:m1:x"), { teamId: "t1", memberId: "m1:x" });
  assert.equal(parseTeamSessionKey("cap-1"), undefined);
  assert.equal(parseTeamSessionKey("team:t1"), undefined);
});

test("isCaptainSession / resolveActor", () => {
  assert.equal(isCaptainSession("cap-1"), true);
  assert.equal(isCaptainSession("team:t1:m1"), false);
  // 成员会话形态（team: / team- 前缀）即便解析失败也不是队长会话
  assert.equal(isCaptainSession("team-t1-m1"), false);
  assert.equal(isCaptainSession("team:t1:"), false);
  assert.deepEqual(resolveActor("cap-1"), { teamId: "", memberId: "", captain: true });
  assert.deepEqual(resolveActor("team:t1:m1"), { teamId: "t1", memberId: "m1", captain: false });
  assert.equal(resolveActor(undefined), undefined);
  // Windows 净化形态（SessionList TEAM_MEMBER_SESSION_PATTERN /^team[:\-]/，转录文件名回读）：
  // 信息丢失不可解析，fail-closed 返回 undefined，不得误判为队长放行管理操作。
  assert.equal(resolveActor("team-t1-m1"), undefined);
  // 畸形成员形态（空 teamId / 空 memberId / 裸前缀）同样 fail-closed，绝不判为队长
  assert.equal(resolveActor("team:t1:"), undefined);
  assert.equal(resolveActor("team::m1"), undefined);
  assert.equal(resolveActor("team:"), undefined);
});

test("requireCaptain：队长通过；成员/未知会话拒绝", () => {
  assert.doesNotThrow(() => requireCaptain({ teamId: "", memberId: "", captain: true }));
  assert.throws(
    () => requireCaptain({ teamId: "t1", memberId: "m1", captain: false }),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
  assert.throws(
    () => requireCaptain(undefined),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_actor_unknown",
  );
});

test("requireTeamMember：成员通过；captain/异队/退休/未知成员拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-utils-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "researcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });
    const member = db.getMember("m1")!;

    assert.equal(requireTeamMember(db, { teamId: "t1", memberId: "m1", captain: false }, "t1"), "m1");

    assert.throws(
      () => requireTeamMember(db, { teamId: "", memberId: "", captain: true }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
    );
    assert.throws(
      () => requireTeamMember(db, { teamId: "t2", memberId: "m1", captain: false }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
    );
    assert.throws(
      () => requireTeamMember(db, { teamId: "t1", memberId: "no-such", captain: false }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_actor_unknown",
    );
    // M5：memberId 在 db 中已注册但属于 t2，actor 声称 teamId t1 → team_not_member（成员行归属校验）
    db.upsertTeam({ id: "t2", name: "t2", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t2",
      memberId: "m2",
      roleSlug: "researcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });
    assert.throws(
      () => requireTeamMember(db, { teamId: "t1", memberId: "m2", captain: false }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
    );
    db.insertRetired(member.sessionKey, "m1", "test");
    assert.throws(
      () => requireTeamMember(db, { teamId: "t1", memberId: "m1", captain: false }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_member_retired",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requireRegisteredRole：注册角色通过；未知角色拒绝", async () => {
  const { registerRoleDefinition, unregisterRoleDefinition } = await import(
    "../../../../src/agent/sub/builtinSubagentTypes.js"
  );
  const def = {
    id: "team-utils-test-role",
    description: "test",
    allowedTools: [],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix: "test",
  };
  registerRoleDefinition(def);
  try {
    requireRegisteredRole("team-utils-test-role"); // 不抛
    assert.throws(
      () => requireRegisteredRole("no-such-role"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
    );
  } finally {
    unregisterRoleDefinition("team-utils-test-role");
  }
});
