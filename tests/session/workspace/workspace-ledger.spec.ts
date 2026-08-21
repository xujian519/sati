/**
 * WorkspaceLedger 状态机测试（J-Space 账本）。
 *
 * 覆盖：打开需 Goal+Next、Next 永不为空、Verified 需覆盖范围、
 * Open 需 settle-by、close 需同次记录 checkpoint、编号不复用、
 * Core 最多 2 live + 显式 swap、混合调用不丢弃独立合法编辑。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkspaceNote,
  emptyWorkspaceLedger,
  nextOpenNumber,
  renderWorkspaceLedgerBlock,
  type WorkspaceLedgerState,
  type WorkspaceNoteInput,
} from "../../../src/session/workspace/WorkspaceLedger.js";

function open(): WorkspaceLedgerState {
  return applyWorkspaceNote(emptyWorkspaceLedger(), {
    goal: "Ship verified output",
    next: "Inspect inputs",
  }).state;
}

test("opening the ledger requires both Goal and Next", () => {
  const onlyGoal = applyWorkspaceNote(emptyWorkspaceLedger(), { goal: "goal only" });
  assert.equal(onlyGoal.changed, false);
  assert.ok(onlyGoal.rejected.some(text => text.includes("requires both Goal and Next")));

  const onlyNext = applyWorkspaceNote(emptyWorkspaceLedger(), { next: "next only" });
  assert.equal(onlyNext.changed, false);
  assert.ok(onlyNext.rejected.some(text => text.includes("requires both Goal and Next")));

  const both = applyWorkspaceNote(emptyWorkspaceLedger(), { goal: "g", next: "n" });
  assert.equal(both.changed, true);
  assert.equal(both.state.goal, "g");
  assert.equal(both.state.next, "n");
});

test("Next is never empty on an open ledger", () => {
  const state = open();
  const cleared = applyWorkspaceNote(state, { next: "   " });
  assert.equal(cleared.changed, false);
  assert.ok(cleared.rejected.length > 0);
  assert.equal(cleared.state.next, "Inspect inputs");
});

test("verified checkpoint requires verifier and coverage", () => {
  const state = open();
  const noBy = applyWorkspaceNote(state, { check: "the parser preserves state" });
  assert.equal(noBy.changed, false);
  assert.ok(noBy.rejected.some(text => text.includes("--by")));

  const noCoverage = applyWorkspaceNote(state, {
    check: "the parser preserves state",
    by: "by intuition",
  });
  assert.equal(noCoverage.changed, false);
  assert.ok(noCoverage.rejected.some(text => text.includes("coverage")));

  const covered = applyWorkspaceNote(state, {
    check: "the parser preserves state",
    by: "unittest over all ledger sections and edge inputs",
  });
  assert.equal(covered.changed, true);
  assert.equal(covered.state.verified.length, 1);
  assert.equal(covered.state.verified[0]!.number, 1);
});

test("open question requires settle-by and its number is never reused", () => {
  const state = open();
  const noSettle = applyWorkspaceNote(state, { open: "does the parser preserve state?" });
  assert.equal(noSettle.changed, false);
  assert.ok(noSettle.rejected.some(text => text.includes("settled")));

  const opened = applyWorkspaceNote(state, {
    open: "does the parser preserve state?",
    settledBy: "controller tests over all ledger sections",
  });
  assert.equal(opened.changed, true);
  assert.equal(opened.state.open[0]!.number, 1);

  const closeWithoutCheck = applyWorkspaceNote(opened.state, { close: 1 });
  assert.equal(closeWithoutCheck.changed, false);
  assert.ok(closeWithoutCheck.rejected.some(text => text.includes("recorded checkpoint")));

  const closed = applyWorkspaceNote(opened.state, {
    close: 1,
    check: "the parser preserves state",
    by: "unittest over all ledger sections and edge inputs",
  });
  assert.equal(closed.changed, true);
  assert.equal(closed.state.open.length, 0);
  assert.equal(closed.state.verified[0]!.closesOpen, 1);

  const reopened = applyWorkspaceNote(closed.state, {
    open: "second question",
    settledBy: "test over all inputs",
  });
  assert.equal(reopened.state.open[0]!.number, 2);
});

test("nextOpenNumber never reuses a closed open number", () => {
  const state = open();
  const opened = applyWorkspaceNote(state, {
    open: "first",
    settledBy: "test over all inputs",
  }).state;
  const closed = applyWorkspaceNote(opened, {
    close: 1,
    check: "first settled",
    by: "test over all inputs",
  }).state;
  const reopened = applyWorkspaceNote(closed, {
    open: "second",
    settledBy: "test over all inputs",
  }).state;
  assert.equal(nextOpenNumber(reopened), 3);
});

test("core holds at most two live entries and swap is explicit", () => {
  let state = open();
  state = applyWorkspaceNote(state, { core: "constraints — preserve public behavior" }).state;
  state = applyWorkspaceNote(state, { core: "evidence — cover all affected files" }).state;
  assert.equal(state.core.filter(entry => entry.live).length, 2);

  // Third entry is parked, not live.
  state = applyWorkspaceNote(state, { core: "delivery — keep the outer register clean" }).state;
  assert.equal(state.core.filter(entry => entry.live).length, 2);
  assert.equal(state.core.filter(entry => !entry.live).length, 1);

  // Swap slot 1.
  const swapped = applyWorkspaceNote(state, {
    core: "delivery — keep the outer register clean",
    coreSlot: 1,
  });
  assert.equal(swapped.changed, true);
  const live = swapped.state.core.filter(entry => entry.live);
  assert.equal(live[0]!.text, "delivery — keep the outer register clean");
});

test("core slot swap demotes the displaced entry and never duplicates", () => {
  let state = open();
  state = applyWorkspaceNote(state, { core: "constraints — preserve public behavior" }).state;
  state = applyWorkspaceNote(state, { core: "evidence — cover all affected files" }).state;
  // Third entry parked; promote it into slot 1 in a later call.
  state = applyWorkspaceNote(state, { core: "delivery — keep the outer register clean" }).state;
  assert.equal(state.core.filter(entry => entry.live).length, 2);
  assert.equal(state.core.filter(entry => !entry.live).length, 1);

  const swapped = applyWorkspaceNote(state, {
    core: "delivery — keep the outer register clean",
    coreSlot: 1,
  });
  assert.equal(swapped.changed, true);
  const live = swapped.state.core.filter(entry => entry.live);
  const parked = swapped.state.core.filter(entry => !entry.live);
  // Exactly two live entries survive the swap.
  assert.equal(live.length, 2);
  // The displaced "constraints" is demoted to parked, not left live.
  assert.equal(
    parked.some(entry => entry.text === "constraints — preserve public behavior"),
    true,
  );
  // No text appears more than once across live + parked.
  const texts = swapped.state.core.map(entry => entry.text);
  assert.equal(new Set(texts).size, texts.length);
});

test("core slot cannot add a live entry beyond the cap", () => {
  let state = open();
  state = applyWorkspaceNote(state, { core: "constraints — preserve public behavior" }).state;
  state = applyWorkspaceNote(state, { core: "evidence — cover all affected files" }).state;
  // coreSlot is typed 1|2; cast the input to exercise the pure function's
  // runtime guard against out-of-range slots (as JSON tool input could be).
  const tooMany = applyWorkspaceNote(state, {
    core: "delivery — keep the outer register clean",
    coreSlot: 3,
  } as unknown as WorkspaceNoteInput);
  assert.equal(tooMany.changed, false);
  assert.ok(tooMany.rejected.some(text => text.includes("does not exist")));
  assert.equal(tooMany.state.core.filter(entry => entry.live).length, 2);
});

test("mixed note applies valid edits and reports rejected ones", () => {
  const state = open();
  const mixed = applyWorkspaceNote(state, {
    goal: "NEW goal",
    core: "just a name",
  });
  // goal 更新被应用；缺少 "name — fact" 形式的 core 项被拒绝。
  assert.equal(mixed.changed, true);
  assert.equal(mixed.state.goal, "NEW goal");
  assert.ok(mixed.rejected.length > 0);
});

test("malformed core entry is rejected", () => {
  const state = open();
  const malformed = applyWorkspaceNote(state, { core: "just a name" });
  assert.equal(malformed.changed, false);
  assert.ok(malformed.rejected.some(text => text.includes("Mentioning is not loading")));
});

test("renderWorkspaceLedgerBlock renders the five sections in order", () => {
  const state = open();
  const block = renderWorkspaceLedgerBlock(state);
  assert.equal(block.empty, false);
  const lines = block.block.split("\n");
  assert.equal(lines[0], "<workspace-state>");
  const goalIndex = lines.findIndex(line => line.startsWith("Goal:"));
  const coreIndex = lines.findIndex(line => line.startsWith("Core:"));
  const verifiedIndex = lines.findIndex(line => line.startsWith("Verified:"));
  const nextIndex = lines.findIndex(line => line.startsWith("Next:"));
  assert.ok(goalIndex < coreIndex && coreIndex < verifiedIndex && verifiedIndex < nextIndex);
  assert.ok(block.block.endsWith("</workspace-state>"));
});

test("empty ledger renders empty", () => {
  const block = renderWorkspaceLedgerBlock(emptyWorkspaceLedger());
  assert.equal(block.empty, true);
  assert.equal(block.block, "");
});
