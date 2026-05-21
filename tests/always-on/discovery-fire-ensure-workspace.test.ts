import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureActiveWorkCycle } from "../../src/always-on/runtime/DiscoveryFire.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import {
  defaultDiscoveryState,
  DiscoveryStateStore,
} from "../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../src/always-on/storage/WorkCycleStore.js";
import type { WorkspaceHandle } from "../../src/always-on/protocol/types.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/workspace/WorkspaceProviderRegistry.js";
import type {
  WorkspacePrepareInput,
  WorkspaceProvider,
  WorkspacePublishOutput,
} from "../../src/always-on/workspace/WorkspaceProvider.js";

class FakeWorktreeProvider implements WorkspaceProvider {
  readonly id = "git-worktree" as const;
  readonly priority = 1;
  prepareCalls = 0;

  constructor(private readonly baseDir: string, private readonly projectId: string) {}

  async isApplicable(): Promise<boolean> {
    return true;
  }

  async prepare(input: WorkspacePrepareInput): Promise<WorkspaceHandle> {
    this.prepareCalls += 1;
    const cwd = join(this.baseDir, this.projectId, input.runId);
    await mkdir(cwd, { recursive: true });
    return {
      runId: input.runId,
      projectKey: input.projectRoot,
      strategy: this.id,
      cwd,
      metadata: { fake: "1" },
    };
  }

  async publish(): Promise<WorkspacePublishOutput> {
    return {};
  }

  async dispose(): Promise<void> {
    // no-op for tests
  }
}

function makeFixture() {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-aon-fire-"));
  const projectKey = "/tmp/projects/sample";
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey });
  const provider = new FakeWorktreeProvider(paths.worktreesDir, paths.projectId);
  const registry = new WorkspaceProviderRegistry();
  registry.add(provider);
  const stateStore = new DiscoveryStateStore(paths);
  const cycleStore = new WorkCycleStore(paths);
  return {
    pilotHome,
    projectKey,
    paths,
    provider,
    registry,
    stateStore,
    cycleStore,
    cleanup: () => rmSync(pilotHome, { recursive: true, force: true }),
  };
}

test("ensureActiveWorkCycle prepares a fresh workspace when state has no cycle", async () => {
  const fx = makeFixture();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const state = defaultDiscoveryState(now);
    const result = await ensureActiveWorkCycle({
      state,
      projectKey: fx.projectKey,
      runId: "run-fresh",
      cycleId: "cycle-1",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      cycleStore: fx.cycleStore,
      now: () => now,
    });
    assert.equal(result.reused, false);
    assert.equal(fx.provider.prepareCalls, 1);
    assert.equal(result.cycle.id, "cycle-1");
    assert.equal(result.cycle.status, "active");
    const persisted = await fx.stateStore.read(now);
    assert.equal(persisted.activeWorkCycleId, "cycle-1");
  } finally {
    fx.cleanup();
  }
});

test("ensureActiveWorkCycle reuses existing cycle when workspace is still on disk", async () => {
  const fx = makeFixture();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const first = await ensureActiveWorkCycle({
      state: defaultDiscoveryState(now),
      projectKey: fx.projectKey,
      runId: "run-first",
      cycleId: "cycle-1",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      cycleStore: fx.cycleStore,
      now: () => now,
    });
    assert.equal(first.reused, false);
    assert.equal(fx.provider.prepareCalls, 1);

    const stateAfterFirst = await fx.stateStore.read(now);
    const second = await ensureActiveWorkCycle({
      state: stateAfterFirst,
      projectKey: fx.projectKey,
      runId: "run-second",
      cycleId: "cycle-2",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      cycleStore: fx.cycleStore,
      now: () => now,
    });
    assert.equal(second.reused, true);
    assert.equal(fx.provider.prepareCalls, 1, "prepare should not be called again");
    assert.equal(second.handle.cwd, first.handle.cwd);
    assert.equal(second.cycle.id, "cycle-1", "should reuse the existing cycle");
  } finally {
    fx.cleanup();
  }
});

test("ensureActiveWorkCycle re-prepares when cycle references a missing cwd", async () => {
  const fx = makeFixture();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const first = await ensureActiveWorkCycle({
      state: defaultDiscoveryState(now),
      projectKey: fx.projectKey,
      runId: "run-first",
      cycleId: "cycle-1",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      cycleStore: fx.cycleStore,
      now: () => now,
    });
    await rm(first.handle.cwd, { recursive: true, force: true });

    const stateAfterFirst = await fx.stateStore.read(now);
    const second = await ensureActiveWorkCycle({
      state: stateAfterFirst,
      projectKey: fx.projectKey,
      runId: "run-second",
      cycleId: "cycle-2",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      cycleStore: fx.cycleStore,
      now: () => now,
    });
    assert.equal(second.reused, false);
    assert.equal(fx.provider.prepareCalls, 2);
    assert.equal(second.cycle.id, "cycle-2", "should create a new cycle");
    assert.notEqual(second.handle.cwd, first.handle.cwd);

    const stateAfterSecond = await fx.stateStore.read(now);
    assert.equal(stateAfterSecond.activeWorkCycleId, "cycle-2");
  } finally {
    fx.cleanup();
  }
});
