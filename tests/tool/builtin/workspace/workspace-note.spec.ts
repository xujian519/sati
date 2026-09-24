/**
 * workspace_note 工具测试。
 *
 * 覆盖：打开需 Goal+Next、拒绝畸形写入、混合调用不丢弃独立合法编辑、
 * 无 provider 时报 unsupported_tool。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceNoteTool } from "../../../../src/tool/builtin/workspace/WorkspaceNoteTool.js";
import type {
  SatiWorkspaceLedgerProvider,
  WorkspaceLedgerReadResult,
} from "../../../../src/session/workspace/WorkspaceLedgerStore.js";
import type { WorkspaceLedgerState, WorkspaceNoteInput } from "../../../../src/session/workspace/WorkspaceLedger.js";
import type { SatiToolRuntimeContext } from "../../../../src/tool/protocol/types.js";

class MemProvider implements SatiWorkspaceLedgerProvider {
  state: WorkspaceLedgerState | undefined;
  writes = 0;
  /** note 透传（#537）：store 据此在锚点之间落增量而非全量快照。 */
  lastNote: WorkspaceNoteInput | undefined;
  /** 置位后 read() 模拟「transcript 读不到」（如超 50MB）。 */
  unreadable = false;
  async read(): Promise<WorkspaceLedgerReadResult> {
    if (this.unreadable) {
      return { status: "unavailable", code: "transcript_too_large", message: "too large" };
    }
    return { status: "ok", state: this.state };
  }
  async write(
    state: WorkspaceLedgerState,
    ctx: { sessionId: string; turnId: string; note?: WorkspaceNoteInput },
  ): Promise<void> {
    this.state = state;
    this.lastNote = ctx.note;
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

test("workspace_note passes the accepted note through to the provider (#537 delta path)", async () => {
  const provider = new MemProvider();
  const tool = createWorkspaceNoteTool();
  // 首笔写入必然落锚点（无基座可重放）；note 仍须透传，store 才能在其后落增量。
  await tool.execute({ goal: "g", next: "n" }, context(provider));
  assert.deepEqual(provider.lastNote, { goal: "g", next: "n" });
  await tool.execute({ check: "parser holds", by: "all cases pass" }, context(provider));
  assert.deepEqual(provider.lastNote, { check: "parser holds", by: "all cases pass" });
  assert.equal(provider.writes, 2);
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

test("workspace_note refuses to write when the ledger cannot be read", async () => {
  const provider = new MemProvider();
  const tool = createWorkspaceNoteTool();
  await tool.execute({ goal: "g", next: "n" }, context(provider));
  assert.equal(provider.writes, 1);
  // transcript 变得不可读：此时写回会以空态为基座，丢掉既有账本 → 必须拒绝。
  provider.unreadable = true;
  await assert.rejects(
    () => tool.execute({ goal: "NEW" }, context(provider)),
    error =>
      (error as { code?: string }).code === "tool_execution_failed" &&
      (error as Error).message.includes("transcript_too_large"),
  );
  assert.equal(provider.writes, 1, "不可读时不得写入");
  assert.equal(provider.state!.goal, "g", "既有账本不得被改写");
});
