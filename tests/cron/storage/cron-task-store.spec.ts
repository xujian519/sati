import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { GatewayEvent } from "../../../src/gateway/index.js";
import { cronRunEventsPath, resolveCronPaths, type CronPaths } from "../../../src/cron/storage/CronPaths.js";
import { CronTaskStore } from "../../../src/cron/storage/CronTaskStore.js";

const tempDirs: string[] = [];

function makeStore(): { store: CronTaskStore; paths: CronPaths } {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-cron-store-"));
  tempDirs.push(pilotHome);
  const paths = resolveCronPaths({ pilotHome, projectKey: "/tmp/project" });
  return { store: new CronTaskStore(paths), paths };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function textDelta(text: string): GatewayEvent {
  return { type: "text_delta", text } as unknown as GatewayEvent;
}

describe("CronTaskStore.appendRunEvent fd 复用", () => {
  it("同一 run 多次追加：全部事件按序落盘", async () => {
    const { store, paths } = makeStore();
    const runId = "run-1";
    for (let index = 0; index < 30; index += 1) {
      await store.appendRunEvent(runId, textDelta(`chunk-${index}`));
    }
    await store.closeRun(runId);

    const lines = readFileSync(cronRunEventsPath(paths, runId), "utf8").trim().split("\n");
    assert.equal(lines.length, 30);
    const first = JSON.parse(lines[0]!) as { runId: string; event: GatewayEvent };
    const last = JSON.parse(lines[29]!) as { runId: string; event: GatewayEvent };
    assert.equal(first.runId, runId);
    assert.equal(first.event.type, "text_delta");
    assert.equal((first.event as { text: string }).text, "chunk-0");
    assert.equal((last.event as { text: string }).text, "chunk-29");
  });

  it("未主动 closeRun 时连续追加仍完整（同一句柄复用）", async () => {
    const { store, paths } = makeStore();
    const runId = "run-2";
    await store.appendRunEvent(runId, textDelta("a"));
    await store.appendRunEvent(runId, textDelta("b"));
    await store.closeRun(runId);

    const lines = readFileSync(cronRunEventsPath(paths, runId), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("不同 run 写入不同文件，互不干扰", async () => {
    const { store, paths } = makeStore();
    await store.appendRunEvent("run-a", textDelta("a"));
    await store.appendRunEvent("run-b", textDelta("b"));
    await store.closeRun("run-a");
    await store.closeRun("run-b");

    assert.ok(readFileSync(cronRunEventsPath(paths, "run-a"), "utf8").includes('"text":"a"'));
    assert.ok(readFileSync(cronRunEventsPath(paths, "run-b"), "utf8").includes('"text":"b"'));
  });

  it("closeRun 幂等：重复调用不抛", async () => {
    const { store } = makeStore();
    await store.appendRunEvent("run-c", textDelta("x"));
    await store.closeRun("run-c");
    await store.closeRun("run-c");
  });

  it("既有任务读写功能不回归", async () => {
    const { store } = makeStore();
    await store.putTask({
      schemaVersion: 1,
      taskId: "t1",
      message: "定时任务",
      schedule: { type: "once", runAt: "2026-08-09T00:10:00.000Z" },
      sessionKey: "cron/session",
      channelKey: "feishu:cli",
      projectKey: "/tmp/project",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      nextRunAt: "2026-08-09T00:10:00.000Z",
      status: "scheduled",
    });
    const tasks = await store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, "t1");
  });

  it("损坏的 tasks.json 备份为 .corrupt-<ts>，而非静默清空数据", async () => {
    const { store, paths } = makeStore();
    mkdirSync(paths.projectDir, { recursive: true });
    const corrupt = "{ not valid json " + "x".repeat(50);
    writeFileSync(paths.tasksFile, corrupt, "utf8");

    const tasks = await store.listTasks();
    assert.deepEqual(tasks, []);

    // 损坏文件被移出原位备份，而非留在原位等下一次 mutation 覆盖。
    const backups = readdirSync(paths.projectDir).filter(name => name.startsWith("tasks.json.corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(paths.projectDir, backups[0]!), "utf8"), corrupt);

    // 后续写任务正常落盘，备份文件仍被保留。
    await store.putTask({
      schemaVersion: 1,
      taskId: "t1",
      message: "定时任务",
      schedule: { type: "once", runAt: "2026-08-09T00:10:00.000Z" },
      sessionKey: "cron/session",
      channelKey: "feishu:cli",
      projectKey: "/tmp/project",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      nextRunAt: "2026-08-09T00:10:00.000Z",
      status: "scheduled",
    });
    assert.equal((await store.listTasks()).length, 1);
    const backupsAfter = readdirSync(paths.projectDir).filter(name => name.startsWith("tasks.json.corrupt-"));
    assert.equal(backupsAfter.length, 1);
  });
});

describe("CronTaskStore 新字段读取（normalizeTask/normalizeRun）", () => {
  it("读取含 modelRoute/maxRuns/retry/lastError/deliveryChannel/offPeak/trigger 的完整任务", async () => {
    const { store, paths } = makeStore();
    mkdirSync(paths.projectDir, { recursive: true });
    writeFileSync(
      paths.tasksFile,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "t-rich",
            message: "定时专利检索",
            schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
            status: "scheduled",
            sessionKey: "cron:t-rich",
            channelKey: "cron",
            projectKey: "/tmp/project",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            nextRunAt: "2026-08-05T09:00:00.000Z",
            trigger: "run-now",
            modelRoute: { provider: "openai", model: "gpt-x" },
            maxRuns: 10,
            runCount: 2,
            retry: { maxAttempts: 3, attempts: 1 },
            lastError: { code: "cron_run_timeout", message: "turn exceeded" },
            deliveryChannel: "weixin:cli",
            offPeak: true,
          },
        ],
      }),
      "utf8",
    );

    const tasks = await store.listTasks();
    assert.equal(tasks.length, 1);
    const task = tasks[0]!;
    assert.equal(task.trigger, "run-now");
    assert.deepEqual(task.modelRoute, { provider: "openai", model: "gpt-x" });
    assert.equal(task.maxRuns, 10);
    assert.equal(task.runCount, 2);
    assert.deepEqual(task.retry, { maxAttempts: 3, attempts: 1 });
    assert.deepEqual(task.lastError, { code: "cron_run_timeout", message: "turn exceeded" });
    assert.equal(task.deliveryChannel, "weixin:cli");
    assert.equal(task.offPeak, true);
  });

  it("旧格式任务（无新字段）→ 各字段归一为 undefined/默认，不破坏读取", async () => {
    const { store, paths } = makeStore();
    mkdirSync(paths.projectDir, { recursive: true });
    writeFileSync(
      paths.tasksFile,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "t-legacy",
            message: "旧任务",
            schedule: { type: "once", runAt: "2026-08-09T00:10:00.000Z" },
            status: "scheduled",
            sessionKey: "cron/t-legacy",
            channelKey: "feishu:cli",
            projectKey: "/tmp/project",
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
            nextRunAt: "2026-08-09T00:10:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const task = (await store.listTasks())[0]!;
    assert.equal(task.trigger, "scheduled");
    assert.equal(task.modelRoute, undefined);
    assert.equal(task.maxRuns, undefined);
    assert.equal(task.runCount, undefined);
    assert.equal(task.retry, undefined);
    assert.equal(task.lastError, undefined);
    assert.equal(task.deliveryChannel, undefined);
    assert.equal(task.offPeak, undefined);
  });

  it("非法字段值被归一（modelRoute 缺 model / maxRuns 负数 / retry 缺 maxAttempts）", async () => {
    const { store, paths } = makeStore();
    mkdirSync(paths.projectDir, { recursive: true });
    writeFileSync(
      paths.tasksFile,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "t-junk",
            message: "脏数据",
            schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
            status: "scheduled",
            sessionKey: "cron/t-junk",
            channelKey: "cron",
            projectKey: "/tmp/project",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            nextRunAt: "2026-08-05T09:00:00.000Z",
            modelRoute: { provider: "openai" },
            maxRuns: -3,
            retry: { attempts: 1 },
            lastError: { code: "only-code" },
          },
        ],
      }),
      "utf8",
    );

    const task = (await store.listTasks())[0]!;
    assert.equal(task.modelRoute, undefined);
    assert.equal(task.maxRuns, undefined);
    assert.equal(task.retry, undefined);
    assert.equal(task.lastError, undefined);
  });

  it("读取 run 记录中的 trigger/attempt/runNumber；缺失字段归一为 scheduled/undefined", async () => {
    const { store, paths } = makeStore();
    mkdirSync(paths.projectDir, { recursive: true });
    writeFileSync(
      paths.runHistoryFile,
      [
        JSON.stringify({
          schemaVersion: 1,
          runId: "r1",
          taskId: "t1",
          sessionKey: "cron:t1",
          startedAt: "2026-08-05T10:00:00.000Z",
          trigger: "run-now",
          attempt: 2,
          runNumber: 1,
        }),
        JSON.stringify({
          schemaVersion: 1,
          runId: "r0",
          taskId: "t1",
          sessionKey: "cron:t1",
          startedAt: "2026-08-05T09:00:00.000Z",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const runs = await store.listRuns(10);
    assert.equal(runs.length, 2);
    const rich = runs.find(run => run.runId === "r1")!;
    assert.equal(rich.trigger, "run-now");
    assert.equal(rich.attempt, 2);
    assert.equal(rich.runNumber, 1);
    const legacy = runs.find(run => run.runId === "r0")!;
    assert.equal(legacy.trigger, "scheduled");
    assert.equal(legacy.attempt, undefined);
    assert.equal(legacy.runNumber, undefined);
  });
});
