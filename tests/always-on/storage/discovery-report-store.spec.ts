import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DiscoveryRunHistoryEvent } from "../../../src/always-on/protocol/types.js";
import {
  resolveAlwaysOnPaths,
  runEventsPath,
  type AlwaysOnPaths,
} from "../../../src/always-on/storage/AlwaysOnPaths.js";
import { DiscoveryReportStore } from "../../../src/always-on/storage/DiscoveryReportStore.js";

const tempDirs: string[] = [];

function makeStore(): { store: DiscoveryReportStore; paths: AlwaysOnPaths } {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-aon-store-"));
  tempDirs.push(pilotHome);
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey: "/tmp/project" });
  return { store: new DiscoveryReportStore(paths), paths };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("DiscoveryReportStore.appendRunEvent fd 复用", () => {
  it("同一 run 多次追加：全部事件按序落盘", async () => {
    const { store, paths } = makeStore();
    const runId = "run-1";
    for (let index = 0; index < 50; index += 1) {
      await store.appendRunEvent(runId, { index, type: "text_delta" });
    }
    await store.closeRun(runId);

    const lines = readFileSync(runEventsPath(paths, runId), "utf8").trim().split("\n");
    assert.equal(lines.length, 50);
    assert.deepEqual(JSON.parse(lines[0]!), { index: 0, type: "text_delta" });
    assert.deepEqual(JSON.parse(lines[49]!), { index: 49, type: "text_delta" });
  });

  it("未主动 closeRun 时连续追加仍完整（同一句柄复用）", async () => {
    const { store, paths } = makeStore();
    const runId = "run-2";
    await store.appendRunEvent(runId, { n: 1 });
    await store.appendRunEvent(runId, { n: 2 });
    await store.appendRunEvent(runId, { n: 3 });
    await store.closeRun(runId);

    const lines = readFileSync(runEventsPath(paths, runId), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[1]!), { n: 2 });
  });

  it("不同 run 写入不同文件，互不干扰", async () => {
    const { store, paths } = makeStore();
    await store.appendRunEvent("run-a", { tag: "a" });
    await store.appendRunEvent("run-b", { tag: "b" });
    await store.closeRun("run-a");
    await store.closeRun("run-b");

    assert.deepEqual(JSON.parse(readFileSync(runEventsPath(paths, "run-a"), "utf8")), { tag: "a" });
    assert.deepEqual(JSON.parse(readFileSync(runEventsPath(paths, "run-b"), "utf8")), { tag: "b" });
  });

  it("closeRun 幂等：重复调用不抛", async () => {
    const { store } = makeStore();
    await store.appendRunEvent("run-c", { n: 1 });
    await store.closeRun("run-c");
    await store.closeRun("run-c");
  });

  it("appendHistory 不回归（低频 run history 仍逐条 append）", async () => {
    const { store, paths } = makeStore();
    const event: DiscoveryRunHistoryEvent = {
      schemaVersion: 1,
      runId: "h1",
      startedAt: "2026-08-09T00:00:00.000Z",
      outcome: "executed",
    };
    await store.appendHistory(event);

    const raw = readFileSync(paths.runHistoryFile, "utf8");
    assert.ok(raw.includes('"runId":"h1"'));
  });
});
