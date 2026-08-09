import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CronRuntimeLogger } from "../../../src/cron/runtime/CronRuntime.js";
import { resolveCronPaths } from "../../../src/cron/storage/CronPaths.js";
import { migrateCronStores } from "../../../src/cron/storage/CronStoreMigration.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makePilotHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-cron-migration-"));
  tempDirs.push(dir);
  return dir;
}

function migrationMarker(pilotHome: string): string {
  return join(pilotHome, "cron", "store-migration-v1.json");
}

function writeProject(
  pilotHome: string,
  dirName: string,
  content: { tasks?: unknown[]; runHistory?: string; events?: Record<string, string> } = {},
): string {
  const projectDir = join(pilotHome, "cron", "projects", dirName);
  mkdirSync(projectDir, { recursive: true });
  if (content.tasks !== undefined) {
    writeFileSync(
      join(projectDir, "tasks.json"),
      `${JSON.stringify({ schemaVersion: 1, tasks: content.tasks }, null, 2)}\n`,
    );
  }
  if (content.runHistory !== undefined) {
    writeFileSync(join(projectDir, "run-history.jsonl"), content.runHistory);
  }
  if (content.events !== undefined) {
    mkdirSync(join(projectDir, "runs"), { recursive: true });
    for (const [runId, text] of Object.entries(content.events)) {
      writeFileSync(join(projectDir, "runs", `${runId}.events.jsonl`), text);
    }
  }
  return projectDir;
}

function readTaskFile(dir: string): { tasks: unknown[] } {
  return JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8")) as { tasks: unknown[] };
}

function readTasksFor(pilotHome: string, projectKey: string): unknown[] {
  return readTaskFile(resolveCronPaths({ pilotHome, projectKey }).projectDir).tasks;
}

function readRunHistory(dir: string): string[] {
  const raw = readFileSync(join(dir, "run-history.jsonl"), "utf-8");
  return raw.split("\n").filter(line => line.trim().length > 0);
}

function readRunHistoryFor(pilotHome: string, projectKey: string): string[] {
  return readRunHistory(resolveCronPaths({ pilotHome, projectKey }).projectDir);
}

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: "t1",
    message: "巡检",
    schedule: { type: "once", runAt: "2026-08-05T00:00:00.000Z" },
    status: "scheduled",
    sessionKey: "cron:t1",
    channelKey: "cron",
    projectKey: "/tmp/project",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    nextRunAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: "r1",
    taskId: "t1",
    sessionKey: "s1",
    startedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function makeLogger(): { logger: CronRuntimeLogger; warns: string[] } {
  const warns: string[] = [];
  return { logger: { info: () => undefined, warn: message => warns.push(message) }, warns };
}

// ---------------------------------------------------------------------------
// 任务迁移
// ---------------------------------------------------------------------------

describe("CronStoreMigration 任务迁移", () => {
  it("任务按 projectKey 重定向到目标项目目录，源目录清空", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", { tasks: [makeTask({ taskId: "t1", projectKey: "/tmp/alpha" })] });

    await migrateCronStores({ pilotHome });

    const targetTasks = readTasksFor(pilotHome, "/tmp/alpha");
    assert.equal(targetTasks.length, 1);
    assert.equal((targetTasks[0] as { taskId: string }).taskId, "t1");
    const sourceDir = join(pilotHome, "cron", "projects", "legacy-1");
    assert.deepEqual(readTaskFile(sourceDir).tasks, []);
    assert.ok(existsSync(migrationMarker(pilotHome)));
  });

  it("同 taskId 重复任务按 updatedAt 保留较新版本", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", {
      tasks: [
        makeTask({ taskId: "dup", projectKey: "/tmp/alpha", updatedAt: "2026-08-01T00:00:00.000Z", message: "old" }),
        makeTask({ taskId: "dup", projectKey: "/tmp/alpha", updatedAt: "2026-08-02T00:00:00.000Z", message: "new" }),
      ],
    });

    await migrateCronStores({ pilotHome });

    const targetTasks = readTasksFor(pilotHome, "/tmp/alpha");
    assert.equal(targetTasks.length, 1);
    assert.equal((targetTasks[0] as { message: string }).message, "new");
  });

  it("无 projectKey 的任务留在源目录", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", { tasks: [makeTask({ taskId: "t1", projectKey: undefined })] });

    await migrateCronStores({ pilotHome });

    const sourceDir = join(pilotHome, "cron", "projects", "legacy-1");
    assert.equal(readTaskFile(sourceDir).tasks.length, 1);
  });

  it("无法解析的 tasks.json 保持原样（blocked 项目），其余项目正常迁移", async () => {
    const pilotHome = makePilotHome();
    const brokenDir = join(pilotHome, "cron", "projects", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "tasks.json"), "{not-json");
    writeProject(pilotHome, "ok-1", { tasks: [makeTask({ taskId: "t2", projectKey: "/tmp/beta" })] });

    await migrateCronStores({ pilotHome });

    assert.equal(readFileSync(join(brokenDir, "tasks.json"), "utf-8"), "{not-json");
    assert.equal(readTasksFor(pilotHome, "/tmp/beta").length, 1);
  });
});

// ---------------------------------------------------------------------------
// run 记录迁移
// ---------------------------------------------------------------------------

describe("CronStoreMigration run 记录", () => {
  it("run 按显式 projectKey 重定向到目标目录", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", {
      runHistory: `${JSON.stringify(makeRun({ runId: "r1", projectKey: "/tmp/alpha" }))}\n`,
    });

    await migrateCronStores({ pilotHome });

    const targetLines = readRunHistoryFor(pilotHome, "/tmp/alpha");
    assert.equal(targetLines.length, 1);
    assert.ok(targetLines[0]!.includes('"runId":"r1"'));
    assert.deepEqual(readRunHistory(join(pilotHome, "cron", "projects", "legacy-1")), []);
  });

  it("run 按 taskId 关联到唯一项目目录", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", {
      tasks: [makeTask({ taskId: "t1", projectKey: "/tmp/alpha" })],
      runHistory: `${JSON.stringify(makeRun({ runId: "r9", taskId: "t1" }))}\n`,
    });

    await migrateCronStores({ pilotHome });

    assert.equal(readRunHistoryFor(pilotHome, "/tmp/alpha").length, 1);
    assert.deepEqual(readRunHistory(join(pilotHome, "cron", "projects", "legacy-1")), []);
  });

  it("run 去重：同 runId 保留带 finishedAt 的终态记录", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", {
      runHistory:
        [
          JSON.stringify(makeRun({ runId: "r1" })),
          JSON.stringify(makeRun({ runId: "r1", finishedAt: "2026-08-05T00:10:00.000Z", outcome: "completed" })),
        ].join("\n") + "\n",
    });

    await migrateCronStores({ pilotHome });

    const sourceDir = join(pilotHome, "cron", "projects", "legacy-1");
    const lines = readRunHistory(sourceDir);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes('"finishedAt"'));
  });

  it("run-history 无效行保留在源目录", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", {
      runHistory: `${JSON.stringify(makeRun({ runId: "r1" }))}\nnot-json-line\n[1,2,3]\n`,
    });

    await migrateCronStores({ pilotHome });

    const sourceDir = join(pilotHome, "cron", "projects", "legacy-1");
    const lines = readRunHistory(sourceDir);
    assert.equal(lines.length, 3);
    assert.ok(lines.some(line => line.includes('"runId":"r1"')));
    assert.ok(lines.includes("not-json-line"));
    assert.ok(lines.includes("[1,2,3]"));
  });

  it("run events 文件迁移到目标目录并与已有事件合并去重", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", {
      tasks: [makeTask({ taskId: "t1", projectKey: "/tmp/alpha" })],
      runHistory: `${JSON.stringify(makeRun({ runId: "r1", taskId: "t1", projectKey: "/tmp/alpha" }))}\n`,
      events: { r1: `${JSON.stringify({ seq: 1 })}\n${JSON.stringify({ seq: 2 })}\n` },
    });
    // 目标目录已存在，且已有同一 run 的一行事件
    const targetDir = resolveCronPaths({ pilotHome, projectKey: "/tmp/alpha" }).projectDir;
    mkdirSync(join(targetDir, "runs"), { recursive: true });
    writeFileSync(join(targetDir, "runs", "r1.events.jsonl"), `${JSON.stringify({ seq: 0 })}\n`);

    await migrateCronStores({ pilotHome });

    const targetEvents = readFileSync(join(targetDir, "runs", "r1.events.jsonl"), "utf-8");
    const lines = targetEvents.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.ok(lines.some(line => line.includes('"seq":0')));
    assert.ok(lines.some(line => line.includes('"seq":2')));
    // 源 events 文件被删除
    assert.ok(!existsSync(join(pilotHome, "cron", "projects", "legacy-1", "runs", "r1.events.jsonl")));
  });
});

// ---------------------------------------------------------------------------
// 锁与完成标记
// ---------------------------------------------------------------------------

describe("CronStoreMigration 锁与标记", () => {
  it("陈旧锁（>10min）被移除并继续迁移，记录 warn", async () => {
    const pilotHome = makePilotHome();
    const rootDir = join(pilotHome, "cron");
    mkdirSync(rootDir, { recursive: true });
    const lockPath = join(rootDir, ".store-migration.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }));
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, old, old);
    writeProject(pilotHome, "legacy-1", { tasks: [makeTask({ taskId: "t1", projectKey: "/tmp/alpha" })] });
    const { logger, warns } = makeLogger();

    await migrateCronStores({ pilotHome, logger });

    assert.ok(existsSync(migrationMarker(pilotHome)));
    assert.ok(!existsSync(lockPath));
    assert.equal(readTasksFor(pilotHome, "/tmp/alpha").length, 1);
    assert.ok(warns.some(message => message.includes("stale lock")));
  });

  it("marker 存在时跳过迁移（不获取锁、不改动任何文件）", async () => {
    const pilotHome = makePilotHome();
    const rootDir = join(pilotHome, "cron");
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "store-migration-v1.json"), "sentinel");
    const lockPath = join(rootDir, ".store-migration.lock");
    writeFileSync(lockPath, "fresh-lock");

    await migrateCronStores({ pilotHome });

    assert.equal(readFileSync(join(rootDir, "store-migration-v1.json"), "utf-8"), "sentinel");
    assert.equal(readFileSync(lockPath, "utf-8"), "fresh-lock");
  });

  it("无 cron 项目时写完成标记并释放锁", async () => {
    const pilotHome = makePilotHome();

    await migrateCronStores({ pilotHome });

    assert.ok(existsSync(migrationMarker(pilotHome)));
    assert.ok(!existsSync(join(pilotHome, "cron", ".store-migration.lock")));
  });

  it("迁移完成后重复执行直接跳过（marker 短路）", async () => {
    const pilotHome = makePilotHome();
    writeProject(pilotHome, "legacy-1", { tasks: [makeTask({ taskId: "t1", projectKey: "/tmp/alpha" })] });

    await migrateCronStores({ pilotHome });
    // 篡改目标文件，验证第二次执行不再改写
    const targetDir = resolveCronPaths({ pilotHome, projectKey: "/tmp/alpha" }).projectDir;
    writeFileSync(join(targetDir, "tasks.json"), "tampered");

    await migrateCronStores({ pilotHome });

    assert.equal(readFileSync(join(targetDir, "tasks.json"), "utf-8"), "tampered");
  });
});
