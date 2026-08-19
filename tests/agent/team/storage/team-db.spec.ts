/**
 * TeamDb：teams/members/retired_members 三表 CRUD + user_version 迁移。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TeamDb } from "../../../../src/agent/team/index.js";

function openDb(): TeamDb {
  return new TeamDb(":memory:");
}

test("迁移：首次打开建三表，user_version 升到 1", () => {
  const db = openDb();
  try {
    assert.equal(db.userVersion(), 1);
    assert.deepEqual(db.listMembers(), []);
  } finally {
    db.close();
  }
});

test("teams：upsert 与读取往返", () => {
  const db = openDb();
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    assert.deepEqual(db.getTeam("t1"), {
      id: "t1",
      name: "专利团队",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    // upsert 幂等：同名覆盖
    db.upsertTeam({ id: "t1", name: "改名", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    assert.equal(db.getTeam("t1")?.name, "改名");
    assert.equal(db.getTeam("missing"), undefined);
  } finally {
    db.close();
  }
});

test("members：插入/状态更新/查询往返", () => {
  const db = openDb();
  try {
    db.insertMember({
      id: "m1",
      teamId: "t1",
      roleSlug: "patent-searcher",
      modelRouteJson: JSON.stringify({ provider: "deepseek", model: "deepseek-v4-flash" }),
      status: "idle",
      sessionKey: "team:t1:m1",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const member = db.getMember("m1");
    assert.equal(member?.status, "idle");
    assert.equal(member?.sessionKey, "team:t1:m1");
    db.updateMemberStatus("m1", "working");
    assert.equal(db.getMember("m1")?.status, "working");
    assert.equal(db.listMembers().length, 1);
  } finally {
    db.close();
  }
});

test("retired_members：登记与查询", () => {
  const db = openDb();
  try {
    assert.equal(db.isRetired("team:t1:m1"), false);
    db.insertRetired("team:t1:m1", "m1", "removed");
    assert.equal(db.isRetired("team:t1:m1"), true);
    // 幂等：重复登记不抛错
    db.insertRetired("team:t1:m1", "m1", "removed");
  } finally {
    db.close();
  }
});
