import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import {
  defaultDiscoveryState,
  DiscoveryStateStore,
  getDayKey,
} from "../../src/always-on/storage/DiscoveryStateStore.js";

function makeStore(): { store: DiscoveryStateStore; cleanup: () => void; politHome: string } {
  const politHome = mkdtempSync(join(tmpdir(), "politdeck-aon-state-"));
  const paths = resolveAlwaysOnPaths({
    politHome,
    projectKey: "/tmp/projects/sample",
  });
  return {
    store: new DiscoveryStateStore(paths),
    cleanup: () => rmSync(politHome, { recursive: true, force: true }),
    politHome,
  };
}

test("DiscoveryStateStore.read returns defaults when no state file exists", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const state = await store.read(now);
    assert.deepEqual(state, defaultDiscoveryState(now));
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore.markFireStarted increments todayRunCount", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const next = await store.markFireStarted("run_001", now);
    assert.equal(next.todayKey, getDayKey(now));
    assert.equal(next.todayRunCount, 1);
    assert.equal(next.lastRunId, "run_001");
    assert.equal(next.lastFireStartedAt, now.toISOString());
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore resets todayRunCount on day rollover", async () => {
  const { store, cleanup } = makeStore();
  try {
    const day1 = new Date("2026-05-08T12:00:00Z");
    await store.markFireStarted("run_001", day1);
    const day2 = new Date("2026-05-09T01:00:00Z");
    const rolled = await store.read(day2);
    assert.equal(rolled.todayKey, getDayKey(day2));
    assert.equal(rolled.todayRunCount, 0);
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore tracks dormant transitions", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const dormant = await store.setDormant(now);
    assert.ok(dormant.dormant);
    assert.equal(dormant.dormant!.since, now.toISOString());

    const cleared = await store.clearDormant(new Date("2026-05-08T12:01:00Z"));
    assert.equal(cleared.dormant, undefined);
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore.markFireCompleted bumps consecutiveFailures only on failure", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    await store.markFireStarted("run_001", now);
    const failed = await store.markFireCompleted({ outcome: "failed", runId: "run_001", now });
    assert.equal(failed.consecutiveFailures, 1);
    const executed = await store.markFireCompleted({ outcome: "executed", runId: "run_002", now });
    assert.equal(executed.consecutiveFailures, 0);
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore.setCurrentWorkspace persists workspace handle round-trip", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const written = await store.setCurrentWorkspace(
      {
        runId: "run_001",
        projectKey: "/tmp/projects/sample",
        strategy: "git-worktree",
        cwd: "/tmp/polit/always-on/worktrees/sample/run_001",
        metadata: { repoRoot: "/tmp/projects/sample", baseBranch: "main", baseCommit: "abc123" },
      },
      now,
    );
    assert.ok(written.currentWorkspace);
    assert.equal(written.currentWorkspace?.runId, "run_001");
    assert.equal(written.currentWorkspace?.strategy, "git-worktree");
    assert.equal(written.currentWorkspace?.metadata.baseBranch, "main");

    const reread = await store.read(now);
    assert.deepEqual(reread.currentWorkspace, written.currentWorkspace);
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore.clearCurrentWorkspace removes the workspace field", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    await store.setCurrentWorkspace(
      {
        runId: "run_001",
        projectKey: "/tmp/projects/sample",
        strategy: "snapshot-copy",
        cwd: "/tmp/polit/always-on/snapshots/sample/run_001",
        metadata: {},
      },
      now,
    );
    const cleared = await store.clearCurrentWorkspace(now);
    assert.equal(cleared.currentWorkspace, undefined);
    const reread = await store.read(now);
    assert.equal(reread.currentWorkspace, undefined);
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore drops malformed currentWorkspace on read", async () => {
  const { store, cleanup, politHome } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    await store.write({
      schemaVersion: 1,
      todayKey: "2026-05-08",
      todayRunCount: 0,
      consecutiveFailures: 0,
    });
    void politHome;
    const reread = await store.read(now);
    assert.equal(reread.currentWorkspace, undefined);
  } finally {
    cleanup();
  }
});
