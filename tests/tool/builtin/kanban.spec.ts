import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanBoardManager } from "../../../src/gateway/kanban/KanbanBoardManager.js";
import {
  createKanbanAddCardTool,
  createKanbanAddColumnTool,
  createKanbanBulkDeleteCardsTool,
  createKanbanBulkMoveCardsTool,
  createKanbanDeleteCardTool,
  createKanbanDeleteColumnTool,
  createKanbanDuplicateCardTool,
  createKanbanGetTool,
  createKanbanMoveCardToWorkspaceTool,
  createKanbanMoveCardTool,
  createKanbanPurgeCardTool,
  createKanbanRenameColumnTool,
  createKanbanRestoreCardTool,
  createKanbanUndoTool,
  createKanbanUpdateCardTool,
} from "../../../src/tool/builtin/kanban.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "session-a",
    turnId: "turn-1",
    cwd,
    permissionMode: "auto",
    permissionContext: { mode: "auto" },
  } as unknown as SatiToolRuntimeContext;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-kanban-tools-"));
  const manager = new KanbanBoardManager();
  const tools = {
    get: createKanbanGetTool(manager),
    addCard: createKanbanAddCardTool(manager),
    updateCard: createKanbanUpdateCardTool(manager),
    deleteCard: createKanbanDeleteCardTool(manager),
    restoreCard: createKanbanRestoreCardTool(manager),
    purgeCard: createKanbanPurgeCardTool(manager),
    bulkDelete: createKanbanBulkDeleteCardsTool(manager),
    bulkMove: createKanbanBulkMoveCardsTool(manager),
    moveCard: createKanbanMoveCardTool(manager),
    duplicateCard: createKanbanDuplicateCardTool(manager),
    moveCardToWorkspace: createKanbanMoveCardToWorkspaceTool(manager),
    addColumn: createKanbanAddColumnTool(manager),
    renameColumn: createKanbanRenameColumnTool(manager),
    deleteColumn: createKanbanDeleteColumnTool(manager),
    undo: createKanbanUndoTool(manager),
  };
  return { root, manager, tools };
}

test("kanban_get 返回默认三列且 cards 为空", async () => {
  const { root, tools } = setup();
  const out = await tools.get.execute({}, makeContext(root));
  const data = out.data as { columns: Array<{ id: string; title: string }>; cards: unknown[] };
  assert.equal(data.columns.length, 3);
  assert.equal(data.cards.length, 0);
  assert.equal(data.columns[0]?.title, "待办");
});

test("kanban_add_card 默认落到第一列并注入 source", async () => {
  const { root, tools } = setup();
  const out = await tools.addCard.execute({ title: "实现登录" }, makeContext(root));
  const data = out.data as { cardId: string; columnId: string; title: string };
  assert.ok(data.cardId.startsWith("k"));
  assert.equal(data.columnId, "c1");
  assert.equal(data.title, "实现登录");

  const board = await tools.get.execute({}, makeContext(root));
  type SourceCard = { id: string; source?: { sessionKey: string; turnId: string } };
  const cards = (board.data as { cards: SourceCard[] }).cards;
  const card = cards[0];
  assert.equal(card?.id, data.cardId);
  assert.equal(card?.source?.sessionKey, "session-a");
  assert.equal(card?.source?.turnId, "turn-1");
});

test("kanban_add_card 显式指定列", async () => {
  const { root, tools } = setup();
  const out = await tools.addCard.execute({ title: "进行中任务", columnId: "c2" }, makeContext(root));
  const data = out.data as { cardId: string; columnId: string };
  assert.equal(data.columnId, "c2");
});

test("kanban_update_card 更新字段", async () => {
  const { root, tools } = setup();
  const added = await tools.addCard.execute({ title: "旧标题" }, makeContext(root));
  const cardId = (added.data as { cardId: string }).cardId;
  const out = await tools.updateCard.execute({ id: cardId, title: "新标题", priority: "high" }, makeContext(root));
  const data = out.data as { cardId: string; updatedAt: string };
  assert.equal(data.cardId, cardId);
  assert.ok(data.updatedAt);

  const board = await tools.get.execute({}, makeContext(root));
  const card = (board.data as { cards: Array<{ id: string; title: string; priority: string }> }).cards.find(
    c => c.id === cardId,
  );
  assert.equal(card?.title, "新标题");
  assert.equal(card?.priority, "high");
});

test("kanban_move_card 跨列并支持 toIndex", async () => {
  const { root, tools } = setup();
  const a = await tools.addCard.execute({ title: "A" }, makeContext(root));
  const _b = await tools.addCard.execute({ title: "B" }, makeContext(root));
  const c = await tools.addCard.execute({ title: "C", columnId: "c2" }, makeContext(root));

  await tools.moveCard.execute(
    { id: (a.data as { cardId: string }).cardId, columnId: "c2", toIndex: 0 },
    makeContext(root),
  );

  const board = await tools.get.execute({}, makeContext(root));
  const c2Cards = (board.data as { cards: Array<{ id: string; columnId: string }> }).cards.filter(
    c => c.columnId === "c2",
  );
  assert.equal(c2Cards.length, 2);
  assert.equal(c2Cards[0]?.id, (a.data as { cardId: string }).cardId);
  assert.equal(c2Cards[1]?.id, (c.data as { cardId: string }).cardId);

  // 原列只剩 B
  const c1Cards = (board.data as { cards: Array<{ columnId: string }> }).cards.filter(c => c.columnId === "c1");
  assert.equal(c1Cards.length, 1);
});

test("kanban_duplicate_card 复制卡片", async () => {
  const { root, tools } = setup();
  const added = await tools.addCard.execute({ title: "源卡" }, makeContext(root));
  const id = (added.data as { cardId: string }).cardId;
  const out = await tools.duplicateCard.execute({ id }, makeContext(root));
  const data = out.data as { cardId: string; title: string };
  assert.notEqual(data.cardId, id);
  assert.match(data.title, /源卡/);
});

test("kanban_delete_card 软删 + kanban_restore_card 恢复 + kanban_purge_card 永久删除", async () => {
  const { root, tools } = setup();
  const added = await tools.addCard.execute({ title: "临时卡" }, makeContext(root));
  const id = (added.data as { cardId: string }).cardId;

  let board = await tools.get.execute({}, makeContext(root));
  assert.equal((board.data as { cards: unknown[] }).cards.length, 1);

  await tools.deleteCard.execute({ id }, makeContext(root));
  board = await tools.get.execute({}, makeContext(root));
  assert.equal((board.data as { cards: unknown[] }).cards.length, 0);

  await tools.restoreCard.execute({ id }, makeContext(root));
  board = await tools.get.execute({}, makeContext(root));
  assert.equal((board.data as { cards: unknown[] }).cards.length, 1);

  await tools.purgeCard.execute({ id }, makeContext(root));
  board = await tools.get.execute({}, makeContext(root));
  assert.equal((board.data as { cards: unknown[] }).cards.length, 0);
});

test("kanban_get includeArchived 包含归档卡", async () => {
  const { root, tools } = setup();
  const added = await tools.addCard.execute({ title: "归档卡" }, makeContext(root));
  const id = (added.data as { cardId: string }).cardId;
  await tools.deleteCard.execute({ id }, makeContext(root));

  const out = await tools.get.execute({ includeArchived: true }, makeContext(root));
  const cards = (out.data as { cards: Array<{ archived: boolean }> }).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.archived, true);
});

test("kanban_bulk_delete_cards / bulk_move_cards", async () => {
  const { root, tools } = setup();
  const a = await tools.addCard.execute({ title: "A" }, makeContext(root));
  const b = await tools.addCard.execute({ title: "B" }, makeContext(root));
  const ids = [(a.data as { cardId: string }).cardId, (b.data as { cardId: string }).cardId];

  const moved = await tools.bulkMove.execute({ ids, columnId: "c2" }, makeContext(root));
  assert.equal((moved.data as { affected: number }).affected, 2);
  let board = await tools.get.execute({}, makeContext(root));
  const c2 = (board.data as { cards: Array<{ columnId: string }> }).cards.filter(c => c.columnId === "c2");
  assert.equal(c2.length, 2);

  const archived = await tools.bulkDelete.execute({ ids }, makeContext(root));
  assert.equal((archived.data as { affected: number }).affected, 2);
  board = await tools.get.execute({}, makeContext(root));
  assert.equal((board.data as { cards: unknown[] }).cards.length, 0);
});

test("kanban_add_column / rename_column / delete_column", async () => {
  const { root, tools } = setup();
  const added = await tools.addColumn.execute({ title: "验收" }, makeContext(root));
  const data = added.data as { columnId: string; title: string };
  assert.ok(data.columnId.startsWith("c"));
  assert.equal(data.title, "验收");

  await tools.renameColumn.execute({ id: data.columnId, title: "已验收" }, makeContext(root));
  let board = await tools.get.execute({}, makeContext(root));
  const col = (board.data as { columns: Array<{ id: string; title: string }> }).columns.find(
    c => c.id === data.columnId,
  );
  assert.equal(col?.title, "已验收");

  await tools.deleteColumn.execute({ id: data.columnId }, makeContext(root));
  board = await tools.get.execute({}, makeContext(root));
  assert.equal((board.data as { columns: unknown[] }).columns.length, 3);
});

test("kanban_undo 回退最近写操作", async () => {
  const { root, tools } = setup();
  await tools.addCard.execute({ title: "撤销卡" }, makeContext(root));
  assert.equal((await tools.get.execute({}, makeContext(root))).data!.cards.length, 1);

  const undone = await tools.undo.execute({}, makeContext(root));
  assert.equal((undone.data as { ok: boolean }).ok, true);
  assert.equal((await tools.get.execute({}, makeContext(root))).data!.cards.length, 0);
});

test("kanban_move_card_to_workspace 跨项目移动", async () => {
  const { root, tools } = setup();
  const targetRoot = mkdtempSync(join(tmpdir(), "sati-kanban-target-"));
  const added = await tools.addCard.execute({ title: "跨项目卡" }, makeContext(root));
  const id = (added.data as { cardId: string }).cardId;

  const out = await tools.moveCardToWorkspace.execute({ id, toWorkspaceId: targetRoot }, makeContext(root));
  const newId = (out.data as { cardId: string }).cardId;

  const sourceBoard = await tools.get.execute({}, makeContext(root));
  assert.equal(sourceBoard.data!.cards.length, 0);

  const targetBoard = await tools.get.execute({}, makeContext(targetRoot));
  assert.equal(targetBoard.data!.cards.length, 1);
  assert.equal(targetBoard.data!.cards[0]?.id, newId);
  assert.equal(targetBoard.data!.cards[0]?.title, "跨项目卡");
});

test("kanban_move_card_to_workspace 相对 toWorkspaceId 基于当前工作区解析", async () => {
  const { root, tools } = setup();
  const added = await tools.addCard.execute({ title: "跨项目卡" }, makeContext(root));
  const id = (added.data as { cardId: string }).cardId;

  // 相对路径应解析到 <current workspace>/target-sub，而非进程 cwd。
  const out = await tools.moveCardToWorkspace.execute({ id, toWorkspaceId: "target-sub" }, makeContext(root));
  const newId = (out.data as { cardId: string }).cardId;

  const targetBoard = await tools.get.execute({}, makeContext(join(root, "target-sub")));
  assert.equal(targetBoard.data!.cards.length, 1);
  assert.equal(targetBoard.data!.cards[0]?.id, newId);
});

test("kanban_move_card_to_workspace 拒绝空 toWorkspaceId 与移到当前工作区", async () => {
  const { root, tools } = setup();
  const added = await tools.addCard.execute({ title: "卡" }, makeContext(root));
  const id = (added.data as { cardId: string }).cardId;

  await assert.rejects(
    () => tools.moveCardToWorkspace.execute({ id, toWorkspaceId: "" }, makeContext(root)),
    /toWorkspaceId must be a non-empty string/,
  );
  // "." 解析回当前工作区：源、目标为同一 store，会二次进入同一 mutex 自死锁，应拒绝。
  await assert.rejects(
    () => tools.moveCardToWorkspace.execute({ id, toWorkspaceId: "." }, makeContext(root)),
    /Target workspace must differ from the current workspace/,
  );
});
