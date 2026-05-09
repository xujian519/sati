import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAlwaysOnWorkspace } from "../../src/always-on/runtime/DiscoveryFire.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import {
  defaultDiscoveryState,
  DiscoveryStateStore,
} from "../../src/always-on/storage/DiscoveryStateStore.js";
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
  return {
    pilotHome,
    projectKey,
    paths,
    provider,
    registry,
    stateStore,
    cleanup: () => rmSync(pilotHome, { recursive: true, force: true }),
  };
}

test("ensureAlwaysOnWorkspace prepares a fresh workspace when state has none", async () => {
  const fx = makeFixture();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const state = defaultDiscoveryState(now);
    const result = await ensureAlwaysOnWorkspace({
      state,
      projectKey: fx.projectKey,
      runId: "run-fresh",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: () => now,
    });
    assert.equal(result.reused, false);
    assert.equal(fx.provider.prepareCalls, 1);
    const persisted = await fx.stateStore.read(now);
    assert.ok(persisted.currentWorkspace);
    assert.equal(persisted.currentWorkspace?.runId, "run-fresh");
    assert.equal(persisted.currentWorkspace?.cwd, result.handle.cwd);
    assert.equal(persisted.currentWorkspace?.strategy, "git-worktree");
  } finally {
    fx.cleanup();
  }
});

test("ensureAlwaysOnWorkspace reuses existing workspace when cwd is still on disk", async () => {
  const fx = makeFixture();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const first = await ensureAlwaysOnWorkspace({
      state: defaultDiscoveryState(now),
      projectKey: fx.projectKey,
      runId: "run-first",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: () => now,
    });
    assert.equal(first.reused, false);
    assert.equal(fx.provider.prepareCalls, 1);

    const stateAfterFirst = await fx.stateStore.read(now);
    const second = await ensureAlwaysOnWorkspace({
      state: stateAfterFirst,
      projectKey: fx.projectKey,
      runId: "run-second",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: () => now,
    });
    assert.equal(second.reused, true);
    assert.equal(fx.provider.prepareCalls, 1, "prepare should not be called again");
    assert.equal(second.handle.cwd, first.handle.cwd);
    assert.equal(second.handle.runId, "run-first");
  } finally {
    fx.cleanup();
  }
});

test("ensureAlwaysOnWorkspace re-prepares when state references a missing cwd", async () => {
  const fx = makeFixture();
  try {
    const now = new Date("2026-05-08T12:00:00Z");
    const first = await ensureAlwaysOnWorkspace({
      state: defaultDiscoveryState(now),
      projectKey: fx.projectKey,
      runId: "run-first",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: () => now,
    });
    await rm(first.handle.cwd, { recursive: true, force: true });

    const stateAfterFirst = await fx.stateStore.read(now);
    const second = await ensureAlwaysOnWorkspace({
      state: stateAfterFirst,
      projectKey: fx.projectKey,
      runId: "run-second",
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: () => now,
    });
    assert.equal(second.reused, false);
    assert.equal(fx.provider.prepareCalls, 2);
    assert.equal(second.handle.runId, "run-second");
    assert.notEqual(second.handle.cwd, first.handle.cwd);

    const stateAfterSecond = await fx.stateStore.read(now);
    assert.equal(stateAfterSecond.currentWorkspace?.runId, "run-second");
    assert.equal(stateAfterSecond.currentWorkspace?.cwd, second.handle.cwd);
  } finally {
    fx.cleanup();
  }
});
