import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createBackup,
  getBackupFileName,
  restoreBackup,
} from "../../../src/session/index.js";
import { createPilotDeckTempWorkspace } from "../../helpers/filesystem.js";

test("C4.F3 createBackup: ENOENT → null backup marker", async (t) => {
  const ws = await createPilotDeckTempWorkspace({});
  t.after(() => ws.cleanup());
  const backupDir = path.join(ws.cwd, "backups");
  const result = await createBackup({
    filePath: path.join(ws.cwd, "missing.txt"),
    version: 1,
    backupDir,
  });
  assert.equal(result.backup.backupFileName, null);
  assert.equal(result.backup.version, 1);
});

test("C4.F3 createBackup: lazy mkdir + copy + preserve mode", async (t) => {
  const ws = await createPilotDeckTempWorkspace({ "src/foo.ts": "hello" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "src/foo.ts");
  if (process.platform !== "win32") await fs.chmod(file, 0o640);
  const backupDir = path.join(ws.cwd, "backups");
  const result = await createBackup({ filePath: file, version: 1, backupDir });
  assert.notEqual(result.backup.backupFileName, null);
  const backupPath = path.join(backupDir, result.backup.backupFileName!);
  assert.equal(await fs.readFile(backupPath, "utf8"), "hello");
  if (process.platform !== "win32") {
    const stat = await fs.stat(backupPath);
    assert.equal(stat.mode & 0o777, 0o640);
  }
});

test("C4.F3 createBackup: oversize → null backup with oversize flag", async (t) => {
  const ws = await createPilotDeckTempWorkspace({ "big.bin": Buffer.alloc(2048, 0xab) });
  t.after(() => ws.cleanup());
  const result = await createBackup({
    filePath: path.join(ws.cwd, "big.bin"),
    version: 1,
    backupDir: path.join(ws.cwd, "backups"),
    maxFileBytes: 1024,
  });
  assert.equal(result.oversize, true);
  assert.equal(result.backup.backupFileName, null);
});

test("C4.F11 restoreBackup: null backup → unlink target", async (t) => {
  const ws = await createPilotDeckTempWorkspace({ "x.txt": "delete me" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "x.txt");
  const result = await restoreBackup({
    filePath: file,
    backup: { backupFileName: null, version: 1, backupTime: new Date() },
    backupDir: path.join(ws.cwd, "backups"),
  });
  assert.equal(result.outcome, "deleted");
  await assert.rejects(fs.access(file));
});

test("C4.F11 restoreBackup: null backup with already-absent target is idempotent", async (t) => {
  const ws = await createPilotDeckTempWorkspace({});
  t.after(() => ws.cleanup());
  const result = await restoreBackup({
    filePath: path.join(ws.cwd, "missing.txt"),
    backup: { backupFileName: null, version: 1, backupTime: new Date() },
    backupDir: path.join(ws.cwd, "backups"),
  });
  assert.equal(result.outcome, "deleted");
});

test("C4.F9+F10 restoreBackup: copy backup back, restore mode", async (t) => {
  const ws = await createPilotDeckTempWorkspace({ "src/foo.ts": "v1-content" });
  t.after(() => ws.cleanup());
  const file = path.join(ws.cwd, "src/foo.ts");
  const backupDir = path.join(ws.cwd, "backups");
  const created = await createBackup({ filePath: file, version: 1, backupDir });
  await fs.writeFile(file, "v2-content");
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
  const result = await restoreBackup({
    filePath: file,
    backup: { ...created.backup, mode: 0o644 },
    backupDir,
  });
  assert.equal(result.outcome, "restored");
  assert.equal(await fs.readFile(file, "utf8"), "v1-content");
  if (process.platform !== "win32") {
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o644);
  }
});

test("C4.F13 restoreBackup: missing backup file is gracefully reported", async (t) => {
  const ws = await createPilotDeckTempWorkspace({ "x.txt": "" });
  t.after(() => ws.cleanup());
  const fakeName = getBackupFileName("/never/created", 1);
  const result = await restoreBackup({
    filePath: path.join(ws.cwd, "x.txt"),
    backup: { backupFileName: fakeName, version: 1, backupTime: new Date() },
    backupDir: path.join(ws.cwd, "backups"),
  });
  assert.equal(result.outcome, "missing");
});
