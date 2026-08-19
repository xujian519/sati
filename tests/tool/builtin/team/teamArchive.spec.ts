import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { createTeamArchiveTool } from "../../../../src/tool/builtin/team/index.js";

test("team_archive：置 archivedAt + 成员全退休 + team_archived 事件 + 数据保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-archive-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {} as unknown as TeamScheduler;
  const archive = createTeamArchiveTool({ db, scheduler, emit });

  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  db.insertTask({
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
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  try {
    const out = await archive.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never);
    assert.equal((out.data as { archived: boolean }).archived, true);
    assert.ok(db.getTeam("t1")!.archivedAt !== undefined, "archivedAt 已置");
    assert.ok(db.isRetired(db.getMember("m1")!.sessionKey), "成员已退休");
    assert.equal(db.getTask("t1", "a")?.status, "completed", "任务数据保留只读");
    assert.ok(events.some(e => e.type === "team_archived" && e.teamId === "t1"));

    // 重复归档拒绝
    await assert.rejects(
      () => archive.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_already_archived",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("team_archive：未知团队/成员会话拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-archive2-"));
  const db = new TeamDb(join(root, "teams.db"));
  const emit: TeamEventEmitter = () => true;
  const archive = createTeamArchiveTool({ db, scheduler: {} as unknown as TeamScheduler, emit });
  try {
    await assert.rejects(
      () => archive.execute({ teamId: "no-such" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
    );
    await assert.rejects(
      () => archive.execute({ teamId: "no-such" }, { sessionId: "team:t1:m1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
