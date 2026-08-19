/**
 * TeamDb v2：tasks/messages 两表 CRUD + user_version 升到 2。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TeamDb } from "../../../../src/agent/team/index.js";

const TASK_BASE = {
  teamId: "t1",
  subject: "撰写答复稿",
  description: "",
  status: "pending" as const,
  dependencies: [] as string[],
  attempt: 0,
  reassigning: false,
  blockedByCount: 0,
  maxAttempts: 3,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

test("v2 迁移：tasks/messages 表可用，userVersion=2", () => {
  const db = new TeamDb(":memory:");
  try {
    assert.equal(db.userVersion(), 2);
    db.insertTask({ id: "t1", ...TASK_BASE });
    const task = db.getTask("t1", "t1");
    assert.equal(task?.subject, "撰写答复稿");
    assert.equal(task?.status, "pending");
  } finally {
    db.close();
  }
});

test("insertTask 拒绝重复 id（fail-loud）", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertTask({ id: "t1", ...TASK_BASE });
    assert.throws(() => db.insertTask({ id: "t1", ...TASK_BASE }), /UNIQUE constraint/);
  } finally {
    db.close();
  }
});

test("updateTask 全字段 upsert；依赖 JSON 往返保序", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertTask({ id: "t1", ...TASK_BASE });
    db.updateTask({
      id: "t1",
      ...TASK_BASE,
      status: "claimed",
      assigneeId: "m1",
      attempt: 1,
      attemptId: "a1",
      dependencies: ["t0", "t2"],
    });
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "claimed");
    assert.equal(task.assigneeId, "m1");
    assert.equal(task.attemptId, "a1");
    assert.deepEqual(task.dependencies, ["t0", "t2"]);
  } finally {
    db.close();
  }
});

test("listTasks 按 created_at ASC 排序", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertTask({ id: "t1", ...TASK_BASE, createdAt: "2026-08-20T00:00:00.000Z" });
    db.insertTask({ id: "t2", ...TASK_BASE, createdAt: "2026-08-20T00:00:01.000Z" });
    assert.deepEqual(
      db.listTasks("t1").map(t => t.id),
      ["t1", "t2"],
    );
  } finally {
    db.close();
  }
});

test("listMessages：按 recipient 过滤 + insert/update 往返", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertMessage({
      id: "m1",
      teamId: "t1",
      sender: "captain",
      recipient: "m1",
      content: "补充检索",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    db.insertMessage({
      id: "m2",
      teamId: "t1",
      sender: "captain",
      recipient: "m2",
      content: "撰写答复",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    assert.deepEqual(
      db.listMessages("t1", "m1").map(m => m.id),
      ["m1"],
    );
    const msg = db.listMessages("t1", "m1")[0]!;
    db.updateMessage({ ...msg, deliveredAt: "2026-08-20T00:00:00.000Z" });
    assert.equal(db.listMessages("t1", "m1")[0]?.deliveredAt, "2026-08-20T00:00:00.000Z");
    assert.equal(db.listMessages("t1", "m2")[0]?.deliveredAt, undefined);
  } finally {
    db.close();
  }
});
