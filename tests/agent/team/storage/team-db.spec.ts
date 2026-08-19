/**
 * TeamDb：teams/members/retired_members 三表 CRUD + user_version 迁移。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TeamDb } from "../../../../src/agent/team/index.js";

function openDb(): TeamDb {
  return new TeamDb(":memory:");
}

test("迁移：首次打开建表，user_version 升到 3", () => {
  const db = openDb();
  try {
    assert.equal(db.userVersion(), 3);
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
      archivedAt: undefined,
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

test("teams.db v3：archived_at 列迁移 + archiveTeam/isArchived", () => {
  // 先以 v2 建库，再升 v3 验证迁移
  const root = mkdtempSync(join(tmpdir(), "sati-team-db-v3-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    assert.equal(db.isArchived("t1"), false);
    assert.equal(db.archiveTeam("t1", "2026-08-20T00:00:00.000Z"), true);
    assert.equal(db.isArchived("t1"), true);
    assert.equal(db.getTeam("t1")?.archivedAt, "2026-08-20T00:00:00.000Z");
    assert.equal(db.archiveTeam("t1", "2026-08-20T00:01:00.000Z"), false, "重复归档返回 false");
    // 未知团队
    assert.equal(db.archiveTeam("no-such", "2026-08-20T00:00:00.000Z"), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("迁移保护：高于支持版本（user_version=99）打开即 fail-loud", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-teams-db-"));
  const dbPath = join(dir, "teams.db");
  try {
    // 抬高版本模拟"由更新版本程序创建的库"
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    assert.throws(() => new TeamDb(dbPath), /newer than supported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
