import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  InputError,
  NotFoundError,
  projectSessionEvents,
  WorkspaceStore,
  type SessionRow,
} from "../../src/map/index.js";

function makeStore(): { store: WorkspaceStore; cleanup: () => void; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sati-map-"));
  const file = join(dir, ".sati", "map", `workspaces-${randomUUID()}.json`);
  const store = new WorkspaceStore(file);
  return {
    store,
    path: file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("WorkspaceStore", () => {
  test("list returns empty array for a new store", async () => {
    const { store, cleanup } = makeStore();
    try {
      const workspaces = await store.list();
      assert.deepEqual(workspaces, []);
    } finally {
      cleanup();
    }
  });

  test("creates and retrieves a manual workspace", async () => {
    const { store, cleanup } = makeStore();
    try {
      const summary = await store.create("My workspace");
      assert.equal(summary.kind, "manual");
      assert.equal(summary.title, "My workspace");
      assert.equal(summary.threadCount, 0);
      assert.equal(typeof summary.id, "string");

      const full = await store.get(summary.id);
      assert.equal(full.title, "My workspace");
      assert.deepEqual(full.threads, []);

      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, summary.id);
    } finally {
      cleanup();
    }
  });

  test("create rejects invalid titles", async () => {
    const { store, cleanup } = makeStore();
    try {
      await assert.rejects(store.create(""), InputError);
      await assert.rejects(store.create("   "), InputError);
      await assert.rejects(store.create(null as unknown as string), InputError);
    } finally {
      cleanup();
    }
  });

  test("creates a thread inside a workspace", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ws = await store.create("Project");
      const thread = await store.createThread(ws.id, { title: "Thread A" });
      assert.equal(thread.title, "Thread A");
      assert.equal(thread.parentId, null);
      assert.equal(typeof thread.position.x, "number");
      assert.equal(typeof thread.position.y, "number");

      const full = await store.get(ws.id);
      assert.equal(full.threads.length, 1);
      assert.equal(full.threads[0].id, thread.id);
    } finally {
      cleanup();
    }
  });

  test("createThread rejects missing workspace", async () => {
    const { store, cleanup } = makeStore();
    try {
      await assert.rejects(store.createThread("does-not-exist", { title: "T" }), NotFoundError);
    } finally {
      cleanup();
    }
  });

  test("updates a thread", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ws = await store.create("Project");
      const thread = await store.createThread(ws.id, { title: "Old" });
      const updated = await store.updateThread(thread.id, { title: "New", position: { x: 99, y: 88 } });
      assert.equal(updated.title, "New");
      assert.deepEqual(updated.position, { x: 99, y: 88 });

      const full = await store.get(ws.id);
      assert.equal(full.threads[0].title, "New");
    } finally {
      cleanup();
    }
  });

  test("updateThread validates position", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ws = await store.create("Project");
      const thread = await store.createThread(ws.id, { title: "T" });
      await assert.rejects(
        store.updateThread(thread.id, { position: { x: "bad" } as unknown as { x: number; y: number } }),
        InputError,
      );
    } finally {
      cleanup();
    }
  });

  test("branches a thread", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ws = await store.create("Project");
      const parent = await store.createThread(ws.id, { title: "Parent" });
      const child = await store.branch(parent.id, { title: "Child" });
      assert.equal(child.parentId, parent.id);
      assert.equal(child.title, "Child");

      const full = await store.get(ws.id);
      assert.equal(full.threads.length, 2);
    } finally {
      cleanup();
    }
  });

  test("branch uses default title when omitted", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ws = await store.create("Project");
      const parent = await store.createThread(ws.id, { title: "Parent" });
      const child = await store.branch(parent.id, {});
      assert.ok(child.title.includes("Parent"));
    } finally {
      cleanup();
    }
  });

  test("removes a thread", async () => {
    const { store, cleanup } = makeStore();
    try {
      const ws = await store.create("Project");
      const thread = await store.createThread(ws.id, { title: "To remove" });
      const result = await store.removeThread(thread.id);
      assert.deepEqual(result, { removed: 1 });

      const full = await store.get(ws.id);
      assert.equal(full.threads.length, 0);
    } finally {
      cleanup();
    }
  });

  test("removeThread rejects unknown thread", async () => {
    const { store, cleanup } = makeStore();
    try {
      await assert.rejects(store.removeThread("unknown"), NotFoundError);
    } finally {
      cleanup();
    }
  });

  test("syncSessions creates project workspaces and threads", async () => {
    const { store, cleanup } = makeStore();
    try {
      const sessions: SessionRow[] = [
        { id: "s1", title: "First", cwd: "/project-a" },
        { id: "s2", title: "Second", cwd: "/project-a" },
        { id: "s3", title: "Third", cwd: "/project-b" },
      ];

      const { summaries } = await store.syncSessions(sessions, []);
      assert.equal(summaries.length, 2);
      const a = summaries.find(s => s.cwd === "/project-a");
      assert.ok(a);
      assert.equal(a?.threadCount, 2);
      const b = summaries.find(s => s.cwd === "/project-b");
      assert.ok(b);
      assert.equal(b?.threadCount, 1);
    } finally {
      cleanup();
    }
  });

  test("syncSessions skips blank and removed sessions", async () => {
    const { store, cleanup } = makeStore();
    try {
      const sessions: SessionRow[] = [
        { id: "s1", title: "Keep", cwd: "/p" },
        { id: "s2", title: "Blank", cwd: "/p", blank: true },
        { id: "s3", title: "Removed", cwd: "/p" },
      ];

      const { summaries } = await store.syncSessions(sessions, ["s3"]);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].threadCount, 1);
    } finally {
      cleanup();
    }
  });

  test("syncSessions keeps hidden sessions hidden", async () => {
    const { store, cleanup, path } = makeStore();
    try {
      // Seed hiddenSessionIds directly so s2 is treated as hidden.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 4, hiddenSessionIds: ["s2"], workspaces: [] }));

      const sessions: SessionRow[] = [
        { id: "s1", title: "Visible", cwd: "/p" },
        { id: "s2", title: "Hidden", cwd: "/p" },
      ];

      const { summaries } = await store.syncSessions(sessions, []);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].threadCount, 1);

      const full = await store.get(summaries[0].id);
      assert.equal(full.threads[0].id, "s1");
    } finally {
      cleanup();
    }
  });

  test("syncSessions does not remove threads of other projects", async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.syncSessions(
        [
          { id: "s1", title: "A1", cwd: "/project-a" },
          { id: "s2", title: "A2", cwd: "/project-a" },
        ],
        [],
      );

      // Switch to project-b: this sync must NOT prune project-a's threads.
      const { summaries, threads } = await store.syncSessions([{ id: "s3", title: "B1", cwd: "/project-b" }], []);
      assert.equal(summaries.length, 2);

      const a = summaries.find(s => s.cwd === "/project-a");
      assert.ok(a);
      assert.equal(a?.threadCount, 2);
      const b = summaries.find(s => s.cwd === "/project-b");
      assert.ok(b);
      assert.equal(b?.threadCount, 1);

      const aThreads = threads.filter(t => t.id === "s1" || t.id === "s2");
      assert.equal(aThreads.length, 2);
    } finally {
      cleanup();
    }
  });

  test("syncSessions removes threads for removed sessions", async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.syncSessions([{ id: "s1", title: "One", cwd: "/p" }], []);
      const { summaries } = await store.syncSessions([], ["s1"]);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].threadCount, 0);
    } finally {
      cleanup();
    }
  });

  test("syncSessions updates existing thread titles", async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.syncSessions([{ id: "s1", title: "Old", cwd: "/p" }], []);
      const { summaries } = await store.syncSessions([{ id: "s1", title: "New", cwd: "/p" }], []);
      assert.equal(summaries[0].threadCount, 1);

      const wsId = summaries[0].id;
      const full = await store.get(wsId);
      assert.equal(full.threads[0].title, "New");
      assert.equal(full.threads[0].sessionTitle, "New");
    } finally {
      cleanup();
    }
  });

  test("syncSessions sets thread parentId from session.parentId", async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.syncSessions(
        [
          { id: "parent", title: "Parent", cwd: "/p" },
          { id: "child", title: "Child", cwd: "/p", parentId: "parent" },
        ],
        [],
      );
      const summaries = await store.list();
      const ws = await store.get(summaries[0].id);
      const child = ws.threads.find(t => t.id === "child");
      assert.equal(child?.parentId, "parent");
    } finally {
      cleanup();
    }
  });
});

describe("projectSessionEvents", () => {
  test("extracts user and assistant text blocks", () => {
    const events = [
      {
        type: "accepted_input",
        entryId: "e1",
        sequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        turnId: "t1",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      {
        type: "assistant_message",
        entryId: "e2",
        sequence: 2,
        createdAt: "2026-01-01T00:00:01.000Z",
        sessionId: "s1",
        turnId: "t1",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      },
      {
        type: "durable_message",
        entryId: "e3",
        sequence: 3,
        createdAt: "2026-01-01T00:00:02.000Z",
        sessionId: "s1",
        turnId: "t1",
        message: { role: "assistant", content: [{ type: "text", text: "follow-up" }] },
      },
      {
        type: "tool_result_message",
        entryId: "e4",
        sequence: 4,
        createdAt: "2026-01-01T00:00:03.000Z",
        sessionId: "s1",
        turnId: "t1",
        message: { role: "assistant", content: [{ type: "tool_result", toolCallId: "tc1", content: [] }] },
      },
    ];

    const messages = projectSessionEvents(events);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], {
      id: "e1-m0",
      text: "hello",
      kind: "user",
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(messages[1].text, "hi there");
    assert.equal(messages[1].kind, "assistant");
    assert.equal(messages[2].text, "follow-up");
  });

  test("ignores malformed events", () => {
    const messages = projectSessionEvents([null, "string", { type: "unknown" }]);
    assert.deepEqual(messages, []);
  });
});
