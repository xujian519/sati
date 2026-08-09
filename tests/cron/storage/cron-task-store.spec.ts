import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
