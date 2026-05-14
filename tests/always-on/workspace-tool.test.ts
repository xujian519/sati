import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AlwaysOnRunContextRegistry, type WorkspaceRunContext } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { createAlwaysOnWorkspaceTool, ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../../src/always-on/tool/AlwaysOnWorkspaceTool.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import { DiscoveryStateStore } from "../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/workspace/WorkspaceProviderRegistry.js";
import type { WorkspaceHandle } from "../../src/always-on/protocol/types.js";
import type {
  WorkspacePrepareInput,
  WorkspaceProvider,
  WorkspacePublishOutput,
} from "../../src/always-on/workspace/WorkspaceProvider.js";

class FakeProvider implements WorkspaceProvider {
  readonly id = "git-worktree" as const;
  readonly priority = 1;
  prepareCalls = 0;

  constructor(private readonly baseDir: string) {}

  async isApplicable(): Promise<boolean> {
    return true;
  }

  async prepare(input: WorkspacePrepareInput): Promise<WorkspaceHandle> {
    this.prepareCalls += 1;
    const cwd = join(this.baseDir, input.runId);
    await mkdir(cwd, { recursive: true });
    return {
      runId: input.runId,
      projectKey: input.projectRoot,
      strategy: this.id,
      cwd,
      metadata: {},
    };
  }

  async publish(): Promise<WorkspacePublishOutput> {
    return {};
  }

  async dispose(): Promise<void> {}
}

function makeFixture() {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-ws-tool-"));
  const projectKey = "/tmp/projects/sample";
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey });
  const provider = new FakeProvider(paths.worktreesDir);
  const registry = new WorkspaceProviderRegistry();
  registry.add(provider);
  const stateStore = new DiscoveryStateStore(paths);
  const runContexts = new AlwaysOnRunContextRegistry();
  const now = () => new Date("2026-05-10T12:00:00Z");

  const tool = createAlwaysOnWorkspaceTool({ runContexts });

  return {
    pilotHome,
    projectKey,
    paths,
    provider,
    registry,
    stateStore,
    runContexts,
    now,
    tool,
    cleanup: () => rmSync(pilotHome, { recursive: true, force: true }),
  };
}

test(`${ALWAYS_ON_WORKSPACE_TOOL_NAME} prepares a workspace and sets handle on context`, async () => {
  const fx = makeFixture();
  try {
    const sessionKey = "ws-session-1";
    const ctx: WorkspaceRunContext = {
      kind: "workspace",
      sessionKey,
      runId: "run-1",
      projectKey: fx.projectKey,
      paths: fx.paths,
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: fx.now,
    };
    fx.runContexts.register(ctx);

    const result = await fx.tool.execute(
      { strategy: "auto" },
      { sessionId: sessionKey } as Parameters<typeof fx.tool.execute>[1],
    );
    assert.ok(result.data, "tool result must include data");
    assert.ok(result.data.ok);
    assert.equal(result.data.strategy, "git-worktree");
    assert.ok(result.data.cwd.includes("run-1"));
    assert.ok(ctx.handle, "handle should be set on context");
    assert.equal(ctx.handle!.strategy, "git-worktree");
  } finally {
    fx.cleanup();
  }
});

test(`${ALWAYS_ON_WORKSPACE_TOOL_NAME} rejects when called outside workspace turn`, async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(
      () =>
        fx.tool.execute(
          { strategy: "auto" },
          { sessionId: "unknown-session" } as Parameters<typeof fx.tool.execute>[1],
        ),
      (err: Error) => {
        assert.ok(err.message.includes("outside of an Always-On workspace turn"));
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});

test(`${ALWAYS_ON_WORKSPACE_TOOL_NAME} rejects double invocation`, async () => {
  const fx = makeFixture();
  try {
    const sessionKey = "ws-session-double";
    const ctx: WorkspaceRunContext = {
      kind: "workspace",
      sessionKey,
      runId: "run-double",
      projectKey: fx.projectKey,
      paths: fx.paths,
      workspaceRegistry: fx.registry,
      stateStore: fx.stateStore,
      now: fx.now,
    };
    fx.runContexts.register(ctx);

    await fx.tool.execute(
      { strategy: "auto" },
      { sessionId: sessionKey } as Parameters<typeof fx.tool.execute>[1],
    );

    await assert.rejects(
      () =>
        fx.tool.execute(
          { strategy: "auto" },
          { sessionId: sessionKey } as Parameters<typeof fx.tool.execute>[1],
        ),
      (err: Error) => {
        assert.ok(err.message.includes("workspace_already_prepared"));
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});
