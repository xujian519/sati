import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  FileHistoryStore,
  type FileHistorySnapshotRecordedEntry,
} from "../../../src/session/index.js";
import { createPolitDeckTempWorkspace } from "../../helpers/filesystem.js";

function newStore(
  backupDir: string,
  recorded: FileHistorySnapshotRecordedEntry[] = [],
  warns: string[] = [],
): FileHistoryStore {
  return new FileHistoryStore({
    backupDir,
    onSnapshotRecorded: (entry) => recorded.push(entry),
    warn: (m) => warns.push(m),
  });
}

test("C4.F1+F2 trackEdit captures file once per messageId (idempotent)", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "src/x.ts": "v1" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "src/x.ts");
  const recorded: FileHistorySnapshotRecordedEntry[] = [];
  const store = newStore(path.join(ws.cwd, ".bk"), recorded);

  await store.trackEdit(file, "msg-1");
  // mutate file in between (simulating the editor write that follows trackEdit)
  await fs.writeFile(file, "v2");
  await store.trackEdit(file, "msg-1");

  const snapshot = store.getState().snapshots.find((s) => s.messageId === "msg-1");
  assert.ok(snapshot);
  const backup = snapshot.trackedFileBackups[file]!;
  assert.equal(backup.version, 1);
  // Verify the captured backup is "v1" (not "v2")
  const backupContent = await fs.readFile(
    path.join(ws.cwd, ".bk", backup.backupFileName!),
    "utf8",
  );
  assert.equal(backupContent, "v1");
});

test("C4.F8+F9 rewind: restore tracked files from snapshot", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "src/x.ts": "before" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "src/x.ts");
  const store = newStore(path.join(ws.cwd, ".bk"));

  await store.trackEdit(file, "msg-1");
  await fs.writeFile(file, "after");
  const result = await store.rewind("msg-1");
  assert.deepEqual(result.filesChanged, [file]);
  assert.equal(await fs.readFile(file, "utf8"), "before");
});

test("C4.F11 rewind: null backup unlinks created file", async (t) => {
  const ws = await createPolitDeckTempWorkspace({});
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "src/created.ts");
  const store = newStore(path.join(ws.cwd, ".bk"));

  await store.trackEdit(file, "msg-1");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "newly-created");
  await store.rewind("msg-1");
  await assert.rejects(fs.access(file));
});

test("C4.F8 rewind: unknown messageId throws", async (t) => {
  const ws = await createPolitDeckTempWorkspace({});
  t.after(() => ws.cleanup());
  const store = newStore(path.join(ws.cwd, ".bk"));
  await assert.rejects(() => store.rewind("nonexistent"), /No snapshot/);
});

test("C4.F12 onSnapshotRecorded fires for trackEdit and makeSnapshot", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "x.ts": "1" });
  t.after(() => ws.cleanup());
  const recorded: FileHistorySnapshotRecordedEntry[] = [];
  const store = newStore(path.join(ws.cwd, ".bk"), recorded);

  await store.trackEdit(path.join(ws.cwd, "x.ts"), "m1");
  await store.makeSnapshot("m1");

  assert.ok(recorded.length >= 2);
  for (const entry of recorded) {
    assert.equal(entry.messageId, "m1");
    assert.ok(entry.timestamp);
  }
});

test("C4.replayFromTranscript reconstructs state from previously-recorded entries", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "x.ts": "src" });
  t.after(() => ws.cleanup());
  const recorded: FileHistorySnapshotRecordedEntry[] = [];
  const original = newStore(path.join(ws.cwd, ".bk"), recorded);
  await original.trackEdit(path.join(ws.cwd, "x.ts"), "msg-A");
  await original.makeSnapshot("msg-A");

  const replayed = newStore(path.join(ws.cwd, ".bk"));
  replayed.replayFromTranscript(recorded);
  const snap = replayed
    .getState()
    .snapshots.find((s) => s.messageId === "msg-A");
  assert.ok(snap);
  assert.deepEqual(
    Object.keys(snap.trackedFileBackups),
    [path.join(ws.cwd, "x.ts")],
  );
});

test("C4.F13 maxSnapshots eviction drops oldest snapshots and unreferenced backup files", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "a.ts": "1" });
  t.after(() => ws.cleanup());
  const backupDir = path.join(ws.cwd, ".bk");
  const store = new FileHistoryStore({ backupDir, maxSnapshots: 2 });
  for (let i = 0; i < 4; i++) {
    await fs.writeFile(path.join(ws.cwd, "a.ts"), `v${i}`);
    await store.trackEdit(path.join(ws.cwd, "a.ts"), `msg-${i}`);
    await store.makeSnapshot(`msg-${i}`);
  }
  const messageIds = store.getState().snapshots.map((s) => s.messageId);
  assert.equal(messageIds.length, 2);
  assert.deepEqual(messageIds, ["msg-2", "msg-3"]);
  // Sanity: the oldest backup file must be gone (no more snapshots reference it).
  const remaining = await fs.readdir(backupDir);
  assert.ok(remaining.length <= 2);
});

test("C4.F6 makeSnapshot bumps version when file mtime changes between snapshots", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "x.ts": "v1" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "x.ts");
  const store = newStore(path.join(ws.cwd, ".bk"));
  await store.trackEdit(file, "m1");
  await store.makeSnapshot("m1");
  await fs.writeFile(file, "v2");
  // Force mtime advance on systems with second-resolution
  await fs.utimes(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  await store.makeSnapshot("m2");
  const snap = store.getState().snapshots.find((s) => s.messageId === "m2");
  assert.ok(snap);
  assert.ok((snap.trackedFileBackups[file]?.version ?? 0) >= 2);
});

test("C4.F14 getDiffStats reports rough insertions/deletions", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "x.ts": "line1\nline2\nline3\n" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "x.ts");
  const store = newStore(path.join(ws.cwd, ".bk"));
  await store.trackEdit(file, "m1");
  await fs.writeFile(file, "line1\nline2\nALTERED\nADDED\n");
  const stats = await store.getDiffStats("m1");
  assert.equal(stats.filesChanged, 1);
  assert.ok(stats.insertions >= 2);
  assert.ok(stats.deletions >= 1);
});

test("C4 oversize file is skipped with warn", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "big.bin": Buffer.alloc(2048, 0xff) });
  t.after(() => ws.cleanup());
  const warns: string[] = [];
  const store = new FileHistoryStore({
    backupDir: path.join(ws.cwd, ".bk"),
    maxFileBytes: 1024,
    warn: (m) => warns.push(m),
  });
  await store.trackEdit(path.join(ws.cwd, "big.bin"), "m1");
  assert.ok(warns.some((w) => w.includes("size >")));
  const snap = store.getState().snapshots.find((s) => s.messageId === "m1");
  assert.equal(snap?.trackedFileBackups[path.join(ws.cwd, "big.bin")]?.backupFileName, null);
});
