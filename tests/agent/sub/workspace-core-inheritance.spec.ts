/**
 * broadcast-hub 测试。
 *
 * 覆盖：live Core 渲染出协议注记；renderWorkspaceCoreDirective 生成子代理前缀；
 * 无 live core 时为 undefined（指令不变）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkspaceNote,
  emptyWorkspaceLedger,
  renderWorkspaceCoreDirective,
  renderWorkspaceLedgerBlock,
} from "../../../src/session/workspace/WorkspaceLedger.js";

function ledgerWithCore() {
  let state = applyWorkspaceNote(emptyWorkspaceLedger(), { goal: "g", next: "n" }).state;
  state = applyWorkspaceNote(state, { core: "constraints — preserve public behavior" }).state;
  state = applyWorkspaceNote(state, { core: "evidence — cover all affected files" }).state;
  return state;
}

test("renderWorkspaceLedgerBlock shows the hub protocol note with live core", () => {
  const block = renderWorkspaceLedgerBlock(ledgerWithCore());
  assert.equal(block.empty, false);
  assert.ok(block.block.includes("shared hub"));
  assert.ok(block.block.includes("Resolve any divergent value at the hub"));
});

test("renderWorkspaceLedgerBlock omits the protocol note without live core", () => {
  const state = applyWorkspaceNote(emptyWorkspaceLedger(), { goal: "g", next: "n" }).state;
  const block = renderWorkspaceLedgerBlock(state);
  assert.equal(block.empty, false);
  assert.ok(!block.block.includes("shared hub"));
});

test("renderWorkspaceCoreDirective produces a directive prefix with live core", () => {
  const directive = renderWorkspaceCoreDirective(ledgerWithCore());
  assert.ok(directive !== undefined);
  assert.ok(directive!.includes("<workspace-core>"));
  assert.ok(directive!.includes("constraints — preserve public behavior"));
  assert.ok(directive!.includes("write once, read many"));
});

test("renderWorkspaceCoreDirective returns undefined with no live core", () => {
  const state = applyWorkspaceNote(emptyWorkspaceLedger(), { goal: "g", next: "n" }).state;
  assert.equal(renderWorkspaceCoreDirective(state), undefined);
  assert.equal(renderWorkspaceCoreDirective(emptyWorkspaceLedger()), undefined);
});

test("directive prefix is prepended to the subagent directive", () => {
  const directive = renderWorkspaceCoreDirective(ledgerWithCore());
  const subagentDirective = "Analyze the claims.";
  const effective = directive ? `${directive}\n\n${subagentDirective}` : subagentDirective;
  assert.ok(effective.startsWith("<workspace-core>"));
  assert.ok(effective.endsWith("Analyze the claims."));
});
