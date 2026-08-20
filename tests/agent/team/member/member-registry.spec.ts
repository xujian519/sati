/**
 * createTeamMember：成员记录落库 + sessionKey 派生 + 路由快照序列化。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TeamDb, createTeamMember } from "../../../../src/agent/team/index.js";

function setupDb(): TeamDb {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  return db;
}

test("创建：写库并返回完整行", () => {
  const db = setupDb();
  try {
    const row = createTeamMember(db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "patent-searcher",
      modelRoute: { provider: "deepseek", model: "deepseek-v4-flash" },
      now: () => new Date("2026-08-19T08:00:00.000Z"),
    });
    assert.equal(row.sessionKey, "team:t1:m1");
    assert.equal(row.status, "idle");
    assert.equal(row.createdAt, "2026-08-19T08:00:00.000Z"); // now 注入生效
    assert.deepEqual(JSON.parse(row.modelRouteJson), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    assert.equal(db.getMember("m1")?.roleSlug, "patent-searcher");
  } finally {
    db.close();
  }
});

test("创建：同一 team 不同成员 sessionKey 不冲突", () => {
  const db = setupDb();
  try {
    createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    createTeamMember(db, { teamId: "t1", memberId: "m2", roleSlug: "y", modelRoute: { provider: "p", model: "m" } });
    assert.equal(db.listMembers().length, 2);
    assert.equal(db.getMember("m2")?.sessionKey, "team:t1:m2");
  } finally {
    db.close();
  }
});
