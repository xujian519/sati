/**
 * workspace_note 工具测试。
 *
 * 覆盖：打开需 Goal+Next、拒绝畸形写入、混合调用不丢弃独立合法编辑、
 * 无 provider 时报 unsupported_tool。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceNoteTool } from "../../../../src/tool/builtin/workspace/WorkspaceNoteTool.js";
import type { SatiWorkspaceLedgerProvider } from "../../../../src/session/workspace/WorkspaceLedgerStore.js";
import type { WorkspaceLedgerState } from "../../../../src/session/workspace/WorkspaceLedger.js";
import type { SatiToolRuntimeContext } from "../../../../src/tool/protocol/types.js";

class MemProvider implements SatiWorkspaceLedgerProvider {
  state: WorkspaceLedgerState | undefined;
  writes = 0;
  async read(): Promise<WorkspaceLedgerState | undefined> {
    return this.state;
  }
  async write(state: WorkspaceLedgerState, _ctx: { sessionId: string; turnId: string }): Promise<void> {
    this.state = state;
    this.writes += 1;
  }
}

function context(provider: SatiWorkspaceLedgerProvider): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: {} as never,
    workspaceLedger: provider,
  };
}

test("workspace_note refuses to open without Goal and Next", async () => {
  const provider = new MemProvider();
  const tool = createWorkspaceNoteTool();
  const out = await tool.execute({ goal: "g" }, context(provider));
  assert.equal(out.data!.changed, false);
  assert.ok(out.data!.rejected.some(text => text.includes("requires both Goal and Next")));
  assert.equal(provider.writes, 0);
});

test("workspace_note opens the ledger and persists", async () => {
  const provider = new MemProvider();
  const tool = createWorkspaceNoteTool();
  const out = await tool.execute({ goal: "g", next: "n" }, context(provider));
  assert.equal(out.data!.changed, true);
  assert.equal(provider.state!.goal, "g");
  assert.equal(provider.state!.next, "n");
  assert.equal(provider.writes, 1);
});

test("workspace_note applies valid edits and reports rejected ones", async () => {
  const provider = new MemProvider();
  const tool = createWorkspaceNoteTool();
  await tool.execute({ goal: "g", next: "n" }, context(provider));
  const out = await tool.execute({ goal: "NEW", core: "just a name" }, context(provider));
  // goal 更新被应用；缺少 "name — fact" 形式的 core 项被拒绝。
  assert.equal(provider.state!.goal, "NEW");
  assert.equal(out.data!.changed, true);
  assert.ok(out.data!.rejected.length > 0);
});

test("workspace_note requires coverage on a checkpoint", async () => {
  const provider = new MemProvider();
  const tool = createWorkspaceNoteTool();
  await tool.execute({ goal: "g", next: "n" }, context(provider));
  const out = await tool.execute({ check: "parser holds", by: "by intuition" }, context(provider));
  assert.equal(out.data!.changed, false);
  assert.ok(out.data!.rejected.some(text => text.includes("coverage")));
});

test("workspace_note reports unsupported_tool without a provider", async () => {
  const tool = createWorkspaceNoteTool();
  await assert.rejects(
    () => tool.execute({ goal: "g", next: "n" }, context(undefined as unknown as SatiWorkspaceLedgerProvider)),
    error => (error as { code?: string }).code === "unsupported_tool",
  );
});
