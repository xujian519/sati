import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getBackupFileName } from "../../../src/session/filesystem/backupNaming.js";
import {
  FileHistoryStore,
  type FileHistorySnapshotRecordedEntry,
} from "../../../src/session/filesystem/FileHistoryStore.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXED_NOW = () => new Date("2026-08-09T00:00:00.000Z");

type FixtureOverrides = {
  maxFileBytes?: number;
  maxSnapshots?: number;
  now?: () => Date;
  warn?: (message: string) => void;
  onSnapshotRecorded?: (entry: FileHistorySnapshotRecordedEntry, kind: "create" | "update") => void;
};

function makeFixture(overrides: FixtureOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "sati-file-history-"));
  tempDirs.push(root);
  const backupDir = join(root, "backups");
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  const store = new FileHistoryStore({
    backupDir,
    ...(overrides.maxFileBytes !== undefined ? { maxFileBytes: overrides.maxFileBytes } : {}),
    ...(overrides.maxSnapshots !== undefined ? { maxSnapshots: overrides.maxSnapshots } : {}),
    now: overrides.now ?? FIXED_NOW,
    ...(overrides.warn !== undefined ? { warn: overrides.warn } : {}),
    ...(overrides.onSnapshotRecorded !== undefined ? { onSnapshotRecorded: overrides.onSnapshotRecorded } : {}),
  });
  return { root, backupDir, sourceDir, store };
}

function writeSource(sourceDir: string, name: string, content: string): string {
  const file = join(sourceDir, name);
  writeFileSync(file, content, "utf-8");
  return file;
}

/** 把 mtime 拨到指定的未来时刻，保证与 trackEdit 时缓存的 mtime 不同。 */
function bumpMtime(file: string, when: Date): void {
  const stat = statSync(file);
  utimesSync(file, stat.atime, when);
}

describe("FileHistoryStore trackEdit (F1/F2/F3)", () => {
  it("记录 v1 备份并纳入 trackedFiles", async () => {
    const { backupDir, sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "line1\nline2\n");

    await store.trackEdit(file, "m1");

    const state = store.getState();
    assert.deepEqual([...state.trackedFiles], [file]);
    assert.equal(state.snapshots.length, 1);
    const snapshot = state.snapshots[0]!;
    assert.equal(snapshot.messageId, "m1");
    const backup = snapshot.trackedFileBackups[file]!;
    assert.equal(backup.version, 1);
    assert.equal(backup.backupFileName, getBackupFileName(file, 1));
    assert.equal(readFileSync(join(backupDir, backup.backupFileName!), "utf-8"), "line1\nline2\n");
  });

  it("同一 messageId 内重复 trackEdit 不覆盖 v1 备份（F2 幂等）", async () => {
    let recorded = 0;
    const { backupDir, sourceDir, store } = makeFixture({
      onSnapshotRecorded: () => {
        recorded += 1;
      },
    });
    const file = writeSource(sourceDir, "a.ts", "content\n");

    await store.trackEdit(file, "m1");
    assert.equal(recorded, 1, "首次 trackEdit 记录一次 transcript");
    await store.trackEdit(file, "m1");
    assert.equal(recorded, 1, "重复 trackEdit 不应重复记录");

    const backup = store.getState().snapshots[0]!.trackedFileBackups[file]!;
    assert.equal(backup.version, 1);
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 1))), true);
  });

  it("并发 trackEdit 经 mutex 串行，同快照内保留两份文件备份", async () => {
    const { sourceDir, store } = makeFixture();
    const fileA = writeSource(sourceDir, "a.ts", "A");
    const fileB = writeSource(sourceDir, "b.ts", "B");

    await Promise.all([store.trackEdit(fileA, "m1"), store.trackEdit(fileB, "m1")]);

    const snapshot = store.getState().snapshots[0]!;
    assert.deepEqual(Object.keys(snapshot.trackedFileBackups).sort(), [fileA, fileB].sort());
  });

  it("文件不存在时记录 null 备份（F11 语义）", async () => {
    const { sourceDir, store } = makeFixture();
    const missing = join(sourceDir, "missing.ts");

    await store.trackEdit(missing, "m1");

    const backup = store.getState().snapshots[0]!.trackedFileBackups[missing]!;
    assert.equal(backup.backupFileName, null);
    assert.equal(backup.version, 1);
  });

  it("超过 maxFileBytes 的文件被跳过并触发 warn", async () => {
    const warns: string[] = [];
    const { backupDir, sourceDir, store } = makeFixture({ maxFileBytes: 10, warn: m => warns.push(m) });
    const file = writeSource(sourceDir, "big.bin", "x".repeat(100));

    await store.trackEdit(file, "m1");

    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /skipping backup/);
    const backup = store.getState().snapshots[0]!.trackedFileBackups[file]!;
    assert.equal(backup.backupFileName, null);
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 1))), false);
  });
});

describe("FileHistoryStore makeSnapshot (F6/F7)", () => {
  it("mtime 变化时版本递增并生成新备份文件", async () => {
    const { backupDir, sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "v1\n");

    await store.trackEdit(file, "m1");
    writeFileSync(file, "v2\n", "utf-8");
    bumpMtime(file, new Date("2030-01-01T00:00:00.000Z"));
    await store.makeSnapshot("m1");

    const backup = store.getState().snapshots[0]!.trackedFileBackups[file]!;
    assert.equal(backup.version, 2);
    assert.equal(backup.backupFileName, getBackupFileName(file, 2));
    assert.equal(readFileSync(join(backupDir, backup.backupFileName!), "utf-8"), "v2\n");
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 1))), true, "v1 备份应保留");
  });

  it("相邻快照间 mtime 未变化时复用上一快照的备份（不产生新文件）", async () => {
    const { backupDir, sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "stable\n");

    // makeSnapshot 自身会 await stat 并填充 mtimeCache，因此第二个快照必然
    // 能读到确定性的缓存值（不依赖 trackEdit 内部未 await 的 cacheMtime）。
    await store.trackEdit(file, "m1");
    await store.makeSnapshot("m2");
    await store.makeSnapshot("m3"); // 文件未变 → 确定性复用 m2 的备份

    const state = store.getState();
    assert.equal(state.snapshots.length, 3);
    const m2 = state.snapshots[1]!.trackedFileBackups[file]!;
    const m3 = state.snapshots[2]!.trackedFileBackups[file]!;
    assert.equal(m3.backupFileName, m2.backupFileName, "mtime 未变化应复用同一备份文件");
    assert.equal(m3.version, m2.version);
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, m3.version + 1))), false);
  });

  it("trackEdit 后立即 makeSnapshot（缓存未填充）版本会递增——记录源码实际行为", async () => {
    const { backupDir, sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "content\n");

    // 无 tick：trackEdit 内 fire-and-forget 的 cacheMtime 尚未写入 mtimeCache，
    // mtime 视为"已变化" → 递增到 v2。这是当前源码的确定性行为（无真实 I/O 间隔时）。
    await store.trackEdit(file, "m1");
    await store.makeSnapshot("m2");

    const backup = store.getState().snapshots[1]!.trackedFileBackups[file]!;
    assert.equal(backup.version, 2);
    assert.equal(backup.backupFileName, getBackupFileName(file, 2));
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 1))), true);
  });
});

describe("FileHistoryStore rewind (F8/F9/F11)", () => {
  it("回滚到快照版本的内容", async () => {
    const { sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "one\n");

    await store.trackEdit(file, "m1");
    writeFileSync(file, "two\n", "utf-8");
    bumpMtime(file, new Date("2030-01-01T00:00:00.000Z"));
    await store.makeSnapshot("m1"); // 快照现在指向 v2 = "two\n"
    writeFileSync(file, "three\n", "utf-8");

    const result = await store.rewind("m1");

    assert.deepEqual(result, { filesChanged: [file], missing: [] });
    assert.equal(readFileSync(file, "utf-8"), "two\n");
  });

  it("null 备份回滚时 unlink 目标文件（F11）", async () => {
    const { sourceDir, store } = makeFixture();
    const missing = join(sourceDir, "ghost.ts");

    await store.trackEdit(missing, "m1");
    writeFileSync(missing, "created-later\n", "utf-8");

    const result = await store.rewind("m1");

    assert.deepEqual(result.filesChanged, [missing]);
    assert.deepEqual(result.missing, []);
    assert.equal(existsSync(missing), false);
  });

  it("备份文件丢失时报告 missing 并触发 warn，目标文件不受影响", async () => {
    const warns: string[] = [];
    const { backupDir, sourceDir, store } = makeFixture({ warn: m => warns.push(m) });
    const file = writeSource(sourceDir, "a.ts", "content\n");

    await store.trackEdit(file, "m1");
    const backupFileName = store.getState().snapshots[0]!.trackedFileBackups[file]!.backupFileName!;
    rmSync(join(backupDir, backupFileName)); // 手动删除备份

    const result = await store.rewind("m1");

    assert.deepEqual(result, { filesChanged: [], missing: [file] });
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /missing on disk/);
    assert.equal(readFileSync(file, "utf-8"), "content\n");
  });

  it("未知 messageId 回滚抛错", async () => {
    const { store } = makeFixture();
    await assert.rejects(() => store.rewind("nope"), /No snapshot for messageId nope/);
  });
});

describe("FileHistoryStore getDiffStats (F14)", () => {
  it("统计增删行数（与当前磁盘状态对比）", async () => {
    const { sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "one\ntwo");

    await store.trackEdit(file, "m1"); // v1 = "one\ntwo"
    writeFileSync(file, "one\nthree", "utf-8");

    const stats = await store.getDiffStats("m1");
    assert.deepEqual(stats, { filesChanged: 1, insertions: 1, deletions: 1 });
  });

  it("快照后删除的文件按行数计入 deletions", async () => {
    const { sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "x\ny");

    await store.trackEdit(file, "m1");
    rmSync(file);

    const stats = await store.getDiffStats("m1");
    assert.deepEqual(stats, { filesChanged: 1, insertions: 0, deletions: 2 });
  });

  it("快照后新建的文件按行数计入 insertions", async () => {
    const { sourceDir, store } = makeFixture();
    const missing = join(sourceDir, "new.ts");

    await store.trackEdit(missing, "m1"); // null 备份
    writeFileSync(missing, "p\nq", "utf-8");

    const stats = await store.getDiffStats("m1");
    assert.deepEqual(stats, { filesChanged: 1, insertions: 2, deletions: 0 });
  });

  it("未知 messageId 抛错", async () => {
    const { store } = makeFixture();
    await assert.rejects(() => store.getDiffStats("nope"), /No snapshot for messageId nope/);
  });
});

describe("FileHistoryStore evictIfNeeded (F13)", () => {
  it("超过 maxSnapshots 淘汰最旧快照并删除无引用的备份文件", async () => {
    const { backupDir, sourceDir, store } = makeFixture({ maxSnapshots: 2 });
    const file = writeSource(sourceDir, "a.ts", "A");

    await store.trackEdit(file, "m1"); // v1
    writeFileSync(file, "B", "utf-8");
    bumpMtime(file, new Date("2030-01-01T00:00:00.000Z"));
    await store.makeSnapshot("m2"); // v2
    writeFileSync(file, "C", "utf-8");
    bumpMtime(file, new Date("2030-01-02T00:00:00.000Z"));
    await store.makeSnapshot("m3"); // v3 → 淘汰 m1，删除 v1

    const state = store.getState();
    assert.deepEqual(
      state.snapshots.map(s => s.messageId),
      ["m2", "m3"],
    );
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 1))), false, "v1 应被删除");
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 2))), true);
    assert.equal(existsSync(join(backupDir, getBackupFileName(file, 3))), true);
  });

  it("仍被剩余快照引用的备份文件在淘汰时保留", async () => {
    const { backupDir, sourceDir, store: original } = makeFixture({ maxSnapshots: 2 });
    const file = writeSource(sourceDir, "a.ts", "stable");

    // 经 trackEdit 产生真实的 v1 备份文件，再用 replayFromTranscript 确定性构造
    // 三个共享同一 v1 备份的快照（避开 trackEdit 未 await cacheMtime 的竞态）。
    await original.trackEdit(file, "m1");
    const v1FileName = original.getState().snapshots[0]!.trackedFileBackups[file]!.backupFileName!;
    assert.equal(v1FileName, getBackupFileName(file, 1));

    const sharedEntry: FileHistorySnapshotRecordedEntry = {
      messageId: "m1",
      trackedFileBackups: {
        [file]: {
          backupFileName: v1FileName,
          version: 1,
          backupTime: "2026-08-09T00:00:00.000Z",
          mode: 0o644,
        },
      },
      timestamp: "2026-08-09T00:00:00.000Z",
    };
    const store = new FileHistoryStore({ backupDir, maxSnapshots: 2, now: FIXED_NOW });
    store.replayFromTranscript([sharedEntry, { ...sharedEntry, messageId: "m2" }, { ...sharedEntry, messageId: "m3" }]);

    // 触发淘汰：4 个快照 > maxSnapshots=2，m1/m2 被淘汰，但 v1 仍被 m3 引用
    await store.makeSnapshot("m4");

    const state = store.getState();
    assert.equal(state.snapshots.length, 2);
    assert.equal(existsSync(join(backupDir, v1FileName)), true, "v1 仍被剩余快照引用，应保留");
  });
});

describe("FileHistoryStore transcript 记录与回放 (F12)", () => {
  it("onSnapshotRecorded 按 kind 发出 file_snapshot_recorded 条目", async () => {
    const recorded: Array<{ entry: FileHistorySnapshotRecordedEntry; kind: "create" | "update" }> = [];
    const { sourceDir, store } = makeFixture({
      onSnapshotRecorded: (entry, kind) => recorded.push({ entry, kind }),
    });
    const file = writeSource(sourceDir, "a.ts", "content\n");

    await store.trackEdit(file, "m1");
    await store.makeSnapshot("m1"); // 已存在 → update
    await store.makeSnapshot("m2"); // 新建 → create

    assert.deepEqual(
      recorded.map(r => r.kind),
      ["update", "update", "create"],
    );
    const first = recorded[0]!.entry;
    assert.equal(first.messageId, "m1");
    assert.equal(typeof first.timestamp, "string");
    const backup = first.trackedFileBackups[file]!;
    assert.equal(backup.version, 1);
    assert.equal(backup.backupFileName, getBackupFileName(file, 1));
    assert.equal(backup.backupTime, "2026-08-09T00:00:00.000Z");
  });

  it("replayFromTranscript 恢复快照状态并支持 rewind", async () => {
    const recorded: FileHistorySnapshotRecordedEntry[] = [];
    const {
      backupDir,
      sourceDir,
      store: original,
    } = makeFixture({
      onSnapshotRecorded: entry => recorded.push(entry),
    });
    const file = writeSource(sourceDir, "a.ts", "before\n");
    await original.trackEdit(file, "m1");
    await original.makeSnapshot("m2");

    // 进程崩溃后：用同一 backupDir 的备份文件重建状态
    const restored = new FileHistoryStore({ backupDir, now: FIXED_NOW });
    restored.replayFromTranscript(recorded);

    const state = restored.getState();
    assert.deepEqual(
      state.snapshots.map(s => s.messageId),
      ["m1", "m2"],
    );
    assert.ok([...state.trackedFiles].includes(file));
    const backup = state.snapshots[0]!.trackedFileBackups[file]!;
    assert.equal(backup.backupFileName, getBackupFileName(file, 1));
    assert.ok(backup.backupTime instanceof Date);
    assert.ok(state.snapshots[0]!.timestamp instanceof Date);

    writeFileSync(file, "after\n", "utf-8");
    const result = await restored.rewind("m1");
    assert.deepEqual(result.filesChanged, [file]);
    assert.equal(readFileSync(file, "utf-8"), "before\n");
  });

  it("回放同一 messageId 时替换已有快照", async () => {
    const { store } = makeFixture();
    const entry: FileHistorySnapshotRecordedEntry = {
      messageId: "m1",
      trackedFileBackups: {},
      timestamp: "2026-08-09T00:00:00.000Z",
    };
    store.replayFromTranscript([entry]);
    store.replayFromTranscript([{ ...entry, timestamp: "2026-08-09T00:00:01.000Z" }]);

    assert.equal(store.getState().snapshots.length, 1);
    assert.equal(store.getState().snapshots[0]!.timestamp.toISOString(), "2026-08-09T00:00:01.000Z");
  });
});

describe("FileHistoryStore 注入依赖", () => {
  it("注入的 now() 决定 backupTime 与快照 timestamp", async () => {
    const { sourceDir, store } = makeFixture();
    const file = writeSource(sourceDir, "a.ts", "x\n");

    await store.trackEdit(file, "m1");

    const snapshot = store.getState().snapshots[0]!;
    assert.equal(snapshot.timestamp.toISOString(), "2026-08-09T00:00:00.000Z");
    assert.equal(snapshot.trackedFileBackups[file]!.backupTime.toISOString(), "2026-08-09T00:00:00.000Z");
  });
});
