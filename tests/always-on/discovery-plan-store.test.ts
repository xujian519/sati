import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DiscoveryPlanStore } from "../../src/always-on/storage/DiscoveryPlanStore.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "plan-store-test-"));
  const paths = resolveAlwaysOnPaths({ pilotHome: dir, projectKey: "/tmp/project" });
  const store = new DiscoveryPlanStore(paths);
  return { store, paths, dir };
}

test("updateStatus syncs executionStatus to 'completed' when status becomes completed", async () => {
  const { store, paths, dir } = await createTempStore();
  try {
    await store.upsert({
      id: "plan_1",
      title: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      status: "executing",
      summary: "",
      rationale: "",
      dedupeKey: "test",
      sourceRunId: "r1",
      planFilePath: "plans/plan_1.md",
    });

    // Simulate Web-side writing executionStatus into the JSON
    const raw = JSON.parse(await readFile(paths.planIndexFile, "utf-8"));
    raw.plans[0].executionStatus = "queued";
    raw.plans[0].executionSessionId = "";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(paths.planIndexFile, JSON.stringify(raw, null, 2), "utf-8");

    // Gateway calls updateStatus with completed
    await store.updateStatus("plan_1", { status: "completed" });

    const index = await store.readIndex();
    const plan = index.plans[0] as Record<string, unknown>;
    assert.equal(plan.status, "completed");
    assert.equal(plan.executionStatus, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateStatus syncs executionStatus to 'failed' when status becomes failed", async () => {
  const { store, paths, dir } = await createTempStore();
  try {
    await store.upsert({
      id: "plan_2",
      title: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      status: "executing",
      summary: "",
      rationale: "",
      dedupeKey: "test2",
      sourceRunId: "r2",
      planFilePath: "plans/plan_2.md",
    });

    const raw = JSON.parse(await readFile(paths.planIndexFile, "utf-8"));
    raw.plans[0].executionStatus = "queued";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(paths.planIndexFile, JSON.stringify(raw, null, 2), "utf-8");

    await store.updateStatus("plan_2", { status: "failed" });

    const index = await store.readIndex();
    const plan = index.plans[0] as Record<string, unknown>;
    assert.equal(plan.status, "failed");
    assert.equal(plan.executionStatus, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateStatus does not add executionStatus when it did not exist", async () => {
  const { store, dir } = await createTempStore();
  try {
    await store.upsert({
      id: "plan_3",
      title: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      status: "executing",
      summary: "",
      rationale: "",
      dedupeKey: "test3",
      sourceRunId: "r3",
      planFilePath: "plans/plan_3.md",
    });

    await store.updateStatus("plan_3", { status: "completed" });

    const index = await store.readIndex();
    const plan = index.plans[0] as Record<string, unknown>;
    assert.equal(plan.status, "completed");
    assert.equal("executionStatus" in plan, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateStatus does not change executionStatus for non-terminal status", async () => {
  const { store, paths, dir } = await createTempStore();
  try {
    await store.upsert({
      id: "plan_4",
      title: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      status: "ready",
      summary: "",
      rationale: "",
      dedupeKey: "test4",
      sourceRunId: "r4",
      planFilePath: "plans/plan_4.md",
    });

    const raw = JSON.parse(await readFile(paths.planIndexFile, "utf-8"));
    raw.plans[0].executionStatus = "queued";
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(paths.planIndexFile, JSON.stringify(raw, null, 2), "utf-8");

    await store.updateStatus("plan_4", { status: "executing" });

    const index = await store.readIndex();
    const plan = index.plans[0] as Record<string, unknown>;
    assert.equal(plan.status, "executing");
    assert.equal(plan.executionStatus, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
