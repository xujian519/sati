import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getBackupFileName } from "../../../src/session/filesystem/backupNaming.js";
import { createBackup } from "../../../src/session/filesystem/createBackup.js";
import { restoreBackup } from "../../../src/session/filesystem/restoreBackup.js";
import type { FileHistoryBackup } from "../../../src/session/filesystem/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXED_NOW = () => new Date("2026-08-09T00:00:00.000Z");

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "sati-backup-restore-"));
  tempDirs.push(root);
  const backupDir = join(root, "backups");
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  return { root, backupDir, sourceDir };
}

function writeSourceFile(sourceDir: string, name: string, content: string, mode = 0o640): string {
  const file = join(sourceDir, name);
  writeFileSync(file, content, "utf-8");
  chmodSync(file, mode);
  return file;
}

describe("createBackup (F3/F4/F5/F10)", () => {
  it("把内容复制到 <backupDir>/<sha16>@v<version> 并保留模式", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "a.ts", "hello\nworld\n", 0o640);

    const result = await createBackup({ filePath: file, version: 3, backupDir, now: FIXED_NOW });

    assert.equal(result.oversize, undefined);
    assert.ok(result.backup.backupFileName);
    assert.equal(result.backup.backupFileName, getBackupFileName(file, 3));
    assert.equal(result.backup.version, 3);
    assert.equal(result.backup.backupTime.toISOString(), "2026-08-09T00:00:00.000Z");
    if (process.platform !== "win32") {
      assert.equal(result.backup.mode !== undefined && result.backup.mode & 0o777, 0o640);
    }

    const backupPath = join(backupDir, result.backup.backupFileName);
    assert.equal(readFileSync(backupPath, "utf-8"), "hello\nworld\n");
    if (process.platform !== "win32") {
      assert.equal(statSync(backupPath).mode & 0o777, 0o640, "备份文件应保留源模式");
    }
  });

  it("源文件不存在（ENOENT）返回 null 备份，且不创建备份目录（lazy mkdir）", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const missing = join(sourceDir, "missing.ts");

    const result = await createBackup({ filePath: missing, version: 1, backupDir, now: FIXED_NOW });

    assert.equal(result.backup.backupFileName, null);
    assert.equal(result.backup.version, 1);
    assert.equal(result.oversize, undefined);
    assert.equal(existsSync(backupDir), false, "lazy mkdir 不应在 stat 失败时触发");
  });

  it("超过 maxFileBytes 返回 null 备份并标记 oversize", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "big.bin", "x".repeat(100));

    const result = await createBackup({ filePath: file, version: 1, backupDir, maxFileBytes: 10 });

    assert.equal(result.backup.backupFileName, null);
    assert.equal(result.backup.version, 1);
    assert.equal(result.oversize, true);
    assert.equal(existsSync(backupDir), false, "超限文件不应产生备份目录");
  });

  it("目录等非文件路径返回 null 备份（无 oversize 标记）", async () => {
    const { backupDir, sourceDir } = makeRoot();

    const result = await createBackup({ filePath: sourceDir, version: 1, backupDir });

    assert.equal(result.backup.backupFileName, null);
    assert.equal(result.backup.version, 1);
    assert.equal(result.oversize, undefined);
  });

  it("未提供 maxFileBytes 时默认 10 MB", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "ok.ts", "small", 0o600);

    const result = await createBackup({ filePath: file, version: 1, backupDir });

    assert.ok(result.backup.backupFileName);
    assert.equal(result.oversize, undefined);
  });
});

describe("restoreBackup (F9/F10/F11)", () => {
  it("从备份文件恢复内容与模式", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "a.ts", "original\n", 0o640);
    const backup = (await createBackup({ filePath: file, version: 1, backupDir })).backup;

    // 模拟源文件被后续编辑破坏
    writeFileSync(file, "corrupted\n", "utf-8");
    chmodSync(file, 0o600);

    const result = await restoreBackup({ filePath: file, backup, backupDir });

    assert.equal(result.outcome, "restored");
    assert.equal(readFileSync(file, "utf-8"), "original\n");
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o640, "恢复后应还原记录的模式");
    }
  });

  it("恢复时自动创建目标文件的父目录", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "a.ts", "content\n", 0o600);
    const backup = (await createBackup({ filePath: file, version: 1, backupDir })).backup;

    const nested = join(sourceDir, "deep", "dir", "restored.ts");
    const result = await restoreBackup({ filePath: nested, backup, backupDir });

    assert.equal(result.outcome, "restored");
    assert.equal(readFileSync(nested, "utf-8"), "content\n");
  });

  it("null 备份 unlink 目标文件（F11）", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "ghost.ts", "exists\n", 0o600);
    const backup: FileHistoryBackup = { backupFileName: null, version: 1, backupTime: new Date() };

    const result = await restoreBackup({ filePath: file, backup, backupDir });

    assert.equal(result.outcome, "deleted");
    assert.equal(existsSync(file), false);
  });

  it("null 备份且目标已不存在时仍返回 deleted（幂等）", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = join(sourceDir, "never-existed.ts");
    const backup: FileHistoryBackup = { backupFileName: null, version: 1, backupTime: new Date() };

    const result = await restoreBackup({ filePath: file, backup, backupDir });

    assert.equal(result.outcome, "deleted");
  });

  it("引用的备份文件缺失时返回 missing，目标文件不受影响", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "a.ts", "untouched\n", 0o600);
    const backup: FileHistoryBackup = {
      backupFileName: "deadbeef00000000@v1",
      version: 1,
      backupTime: new Date(),
    };

    const result = await restoreBackup({ filePath: file, backup, backupDir });

    assert.equal(result.outcome, "missing");
    assert.equal(readFileSync(file, "utf-8"), "untouched\n");
  });
});

describe("createBackup → restoreBackup 往返", () => {
  it("内容与模式完整往返", async () => {
    const { backupDir, sourceDir } = makeRoot();
    const file = writeSourceFile(sourceDir, "a.ts", "line1\nline2\nline3\n", 0o604);
    const backup = (await createBackup({ filePath: file, version: 7, backupDir })).backup;

    rmSync(file); // 模拟文件丢失

    const result = await restoreBackup({ filePath: file, backup, backupDir });
    assert.equal(result.outcome, "restored");
    assert.equal(readFileSync(file, "utf-8"), "line1\nline2\nline3\n");
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o604);
    }
  });
});
