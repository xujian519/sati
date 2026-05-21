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

function makeStore(): { store: DiscoveryStateStore; cleanup: () => void; pilotHome: string } {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-aon-state-"));
  const paths = resolveAlwaysOnPaths({
    pilotHome,
    projectKey: "/tmp/projects/sample",
  });
  return {
    store: new DiscoveryStateStore(paths),
    cleanup: () => rmSync(pilotHome, { recursive: true, force: true }),
    pilotHome,
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

test("DiscoveryStateStore.setActiveWorkCycleId persists cycle id round-trip", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const written = await store.setActiveWorkCycleId("cycle-001", now);
    assert.equal(written.activeWorkCycleId, "cycle-001");

    const reread = await store.read(now);
    assert.equal(reread.activeWorkCycleId, "cycle-001");
  } finally {
    cleanup();
  }
});

test("DiscoveryStateStore.clearActiveWorkCycleId removes the cycle id", async () => {
  const { store, cleanup } = makeStore();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    await store.setActiveWorkCycleId("cycle-001", now);
    const cleared = await store.clearActiveWorkCycleId(now);
    assert.equal(cleared.activeWorkCycleId, undefined);
    const reread = await store.read(now);
    assert.equal(reread.activeWorkCycleId, undefined);
  } finally {
    cleanup();
  }
});
