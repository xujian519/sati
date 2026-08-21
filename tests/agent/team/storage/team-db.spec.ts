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

test("迁移：首次打开建表，user_version 升到 4", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-db-mig-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    // userVersion() 已移除（生产零引用）——外部连接直查 PRAGMA 钉住迁移版本
    const raw = new DatabaseSync(join(root, "teams.db"));
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    raw.close();
    assert.deepEqual(db.listMembers(), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
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

test("transaction：提交成功全部生效；中途抛错整体回滚（T8 review I-1）", () => {
  const db = openDb();
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    db.insertMember({
      id: "m1",
      teamId: "t1",
      roleSlug: "researcher",
      modelRouteJson: "{}",
      status: "idle",
      sessionKey: "team:t1:m1",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    // 提交路径：事务内全部写入生效
    db.transaction(() => {
      db.archiveTeam("t1", "2026-08-20T00:00:00.000Z");
      db.insertRetired("team:t1:m1", "m1", "team_archived");
    });
    assert.notEqual(db.getTeam("t1")?.archivedAt, undefined);
    assert.equal(db.isRetired("team:t1:m1"), true);
    // 回滚路径：失败事务内必须有真实写入（archiveTeam 对已归档团队是 WHERE 守卫下的 0 行 no-op，
    // 单靠它钉不住 ROLLBACK）——insertRetired 为新 key 的真实 INSERT，抛错后断言其未生效，
    // 若 transaction 助手没有 ROLLBACK 本用例即红。
    assert.throws(
      () =>
        db.transaction(() => {
          db.insertRetired("team:t1:m99", "m99", "team_archived");
          db.archiveTeam("t1", "2026-08-20T01:00:00.000Z");
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(db.isRetired("team:t1:m99"), false, "失败事务内的真实写入（insertRetired）已回滚");
    assert.equal(db.getTeam("t1")?.archivedAt, "2026-08-20T00:00:00.000Z", "第二次归档已回滚，保持首次提交值");
    assert.equal(db.isRetired("team:t1:m1"), true, "成员退休保持首次提交值");
  } finally {
    db.close();
  }
});

test("teams.db v3：archived_at 列迁移 + archiveTeam/archivedAt", () => {
  // T8 review M-1 注释诚实化：本用例验证 v3 归档字段往返（new TeamDb(path) 一次跑完 v1→v3），
  // 真实 v2 旧库升级见下方「迁移：v2 旧库升级到 v3」用例
  const root = mkdtempSync(join(tmpdir(), "sati-team-db-v3-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    assert.equal(db.getTeam("t1")?.archivedAt, undefined);
    assert.equal(db.archiveTeam("t1", "2026-08-20T00:00:00.000Z"), true);
    assert.equal(db.getTeam("t1")?.archivedAt, "2026-08-20T00:00:00.000Z");
    assert.equal(db.archiveTeam("t1", "2026-08-20T00:01:00.000Z"), false, "重复归档返回 false");
    // 未知团队
    assert.equal(db.archiveTeam("no-such", "2026-08-20T00:00:00.000Z"), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("迁移：真实 v2 旧库（user_version=2 + 旧数据）升级到 v3，旧行 archivedAt 为 undefined（T8 review M-1）", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-db-v2up-"));
  const dbPath = join(root, "teams.db");
  try {
    // 裸 DatabaseSync 按 v1+v2 schema 建库并置 user_version=2，模拟升级前的真实旧库
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        captain_session_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        role_slug TEXT NOT NULL,
        model_route_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle','working')),
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE retired_members (
        session_key TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        retired_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending','claimed','in_progress','completed','failed','cancelled')),
        assignee_id TEXT,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        attempt INTEGER NOT NULL DEFAULT 0,
        attempt_id TEXT,
        handoff_id TEXT,
        reassigning INTEGER NOT NULL DEFAULT 0,
        blocked_by_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        output TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, id)
      );
      CREATE TABLE messages (
        id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_claimed_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        PRIMARY KEY (team_id, id)
      );
      PRAGMA user_version = 2;
    `);
    raw
      .prepare("INSERT INTO teams (id, name, captain_session_key, created_at) VALUES (?, ?, ?, ?)")
      .run("t-old", "旧团队", "cap-old", "2026-08-01T00:00:00.000Z");
    raw.close();
    // 以 TeamDb 重开：v2 → v4 迁移补 archived_at + worker_name 列，旧行该字段保持 NULL（= undefined）
    const db = new TeamDb(dbPath);
    try {
      // userVersion() 已移除——外部连接直查 PRAGMA 钉住 v2→v4 迁移落点
      const verifyRaw = new DatabaseSync(dbPath);
      assert.equal((verifyRaw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
      verifyRaw.close();
      assert.deepEqual(db.getTeam("t-old"), {
        id: "t-old",
        name: "旧团队",
        captainSessionKey: "cap-old",
        createdAt: "2026-08-01T00:00:00.000Z",
        archivedAt: undefined,
      });
    } finally {
      db.close();
    }
  } finally {
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

test("tasks v4：worker_name 列存取往返（阶段 3）", () => {
  const db = openDb();
  try {
    db.upsertTeam({ id: "t1", name: "团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    db.insertTask({
      id: "t-1",
      teamId: "t1",
      subject: "检索",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      workerName: "patent-search-commander",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    const loaded = db.getTask("t1", "t-1");
    assert.equal(loaded?.workerName, "patent-search-commander");
    // 无 workerName 的任务读回 undefined（不出现空串噪音）。
    db.insertTask({
      id: "t-2",
      teamId: "t1",
      subject: "普通任务",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    assert.equal(db.getTask("t1", "t-2")?.workerName, undefined);
  } finally {
    db.close();
  }
});
