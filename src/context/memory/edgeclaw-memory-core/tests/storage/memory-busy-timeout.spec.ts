/**
 * 记忆库写锁等待：第二个连接遇到写锁时应等待 busy_timeout，而不是立即
 * 抛 SQLITE_BUSY。用子进程持锁，避免同步 busy-wait 阻塞同进程的定时器。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryRepository } from "../../src/core/storage/sqlite.js";

const CHILD_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, 500);
`;

const dir = mkdtempSync(join(tmpdir(), "sati-memory-busy-"));
const dbPath = join(dir, "memory.db");
const repo = new MemoryRepository(dbPath, {
  memoryDir: join(dir, "memory"),
  globalRootDir: join(dir, "global"),
  workspaceDir: dir,
});

after(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

function waitForLock(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    env: { ...process.env, DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "ignore"],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("child did not acquire the write lock in time"));
    }, 5000);

    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve(child);
    });
  });
}

test("并发写入等待写锁释放，而不是立即 SQLITE_BUSY", async () => {
  const child = await waitForLock();
  try {
    const startedAt = Date.now();
    repo.setPipelineState("contended", { ok: true });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs >= 200, `expected the writer to wait for the lock, waited ${elapsedMs}ms`);
    assert.deepEqual(repo.getPipelineState("contended"), { ok: true });
  } finally {
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) {
        resolve();
      } else {
        child.once("exit", () => resolve());
      }
    });
  }
});
