import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BoardStore } from "../../src/board/storage/BoardStore.js";

function tempProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "sati-board-store-"));
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeStore(): { projectRoot: string; store: BoardStore } {
  const projectRoot = tempProjectRoot();
  tempDirs.push(projectRoot);
  return { projectRoot, store: new BoardStore(projectRoot) };
}

describe("BoardStore 基础读写", () => {
  it("缺失看板文件时自动创建默认三列", async () => {
    const { store } = makeStore();
    const board = await store.loadBoard();

    assert.equal(board.version, 1);
    assert.equal(board.columns.length, 3);
    assert.deepEqual(
      board.columns.map(c => c.title),
      ["待办", "进行中", "已完成"],
    );
    assert.deepEqual(board.cards, []);
    assert.equal(board.seq, 3);
  });

  it("首次加载后若调用 save，会原子写入 JSON 文件", async () => {
    const { projectRoot, store } = makeStore();
    await store.loadBoard();

    const files = readdirSync(projectRoot);
    assert.ok(files.includes("kanban-board.json"), "应写入 kanban-board.json");
    const raw = readFileSync(join(projectRoot, "kanban-board.json"), "utf8");
    const parsed = JSON.parse(raw) as { version: number; columns: unknown[] };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.columns.length, 3);
  });

  it("损坏的 JSON 会被备份并重建默认板", async () => {
    const { projectRoot, store } = makeStore();
    writeFileSync(join(projectRoot, "kanban-board.json"), "{ 不是合法 json", "utf8");

    const board = await store.loadBoard();
    assert.equal(board.columns.length, 3);
    assert.equal(board.cards.length, 0);

    const backups = readdirSync(projectRoot).filter(name => name.startsWith("kanban-board.json.corrupt-"));
    assert.equal(backups.length, 1);
  });
});

describe("BoardStore 列操作", () => {
  it("addColumn 新增列并递增 seq", async () => {
    const { store } = makeStore();
    const column = await store.addColumn("待审核");

    assert.ok(column.id.startsWith("c"));
    const board = await store.loadBoard();
    assert.equal(board.columns.length, 4);
    assert.equal(board.columns[3]?.title, "待审核");
    assert.ok(board.seq > 3);
  });

  it("renameColumn 可改列标题", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const columnId = boardBefore.columns[0]!.id;

    await store.renameColumn(columnId, "准备做");
    const board = await store.loadBoard();
    assert.equal(board.columns[0]?.title, "准备做");
  });

  it("renameColumn 对不存在的列抛错", async () => {
    const { store } = makeStore();
    await store.loadBoard();

    await assert.rejects(() => store.renameColumn("c999", "x"), /Column not found/);
  });

  it("deleteColumn 删除列并把卡片并入第一列", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const secondColumnId = boardBefore.columns[1]!.id;

    await store.addCard({ columnId: secondColumnId, title: "任务" });
    await store.deleteColumn(secondColumnId);

    const board = await store.loadBoard();
    assert.equal(board.columns.length, 2);
    assert.equal(board.cards[0]?.columnId, board.columns[0]?.id);
  });

  it("deleteColumn 只剩一列时抛错", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    await store.deleteColumn(boardBefore.columns[2]!.id);
    await store.deleteColumn(boardBefore.columns[1]!.id);

    await assert.rejects(() => store.deleteColumn(boardBefore.columns[0]!.id), /Cannot delete the last column/);
  });
});

describe("BoardStore 卡片 CRUD", () => {
  it("addCard 在指定列追加卡片并注入溯源", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const columnId = boardBefore.columns[0]!.id;

    const source = { sessionKey: "s-1", turnId: "t-1", at: "2026-08-26T12:00:00.000Z" };
    const card = await store.addCard({ columnId, title: "新任务", note: "备注", priority: "high" }, source);

    assert.ok(card.id.startsWith("k"));
    assert.equal(card.columnId, columnId);
    assert.equal(card.title, "新任务");
    assert.equal(card.priority, "high");
    assert.deepEqual(card.source, source);

    const board = await store.loadBoard();
    assert.equal(board.cards.length, 1);
    assert.equal(board.cards[0]?.id, card.id);
  });

  it("updateCard 可更新字段并刷新 updatedAt", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const card = await store.addCard({ columnId: boardBefore.columns[0]!.id, title: "旧" });

    await new Promise(resolve => setTimeout(resolve, 5));
    const updated = await store.updateCard(card.id, { title: "新", priority: "low" });
    assert.equal(updated.title, "新");
    assert.equal(updated.priority, "low");
    assert.ok(updated.updatedAt >= card.updatedAt);
  });

  it("updateCard 不覆盖未提供字段，且写入的 board 可再次加载", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const card = await store.addCard({ columnId: boardBefore.columns[0]!.id, title: "旧", note: "备注" });

    await store.updateCard(card.id, { title: "新" });
    const board = await store.loadBoard();
    const reloaded = board.cards.find(c => c.id === card.id)!;
    assert.equal(reloaded.title, "新");
    assert.equal(reloaded.note, "备注");
    assert.equal(reloaded.archived, false);
  });

  it("updateCard 对不存在的卡片抛错", async () => {
    const { store } = makeStore();
    await store.loadBoard();
    await assert.rejects(() => store.updateCard("k999", { title: "x" }), /Card not found/);
  });

  it("archiveCard / restoreCard 切换 archived 状态", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const card = await store.addCard({ columnId: boardBefore.columns[0]!.id, title: "任务" });

    await store.archiveCard(card.id);
    let board = await store.loadBoard();
    assert.equal(board.cards[0]?.archived, true);

    await store.restoreCard(card.id);
    board = await store.loadBoard();
    assert.equal(board.cards[0]?.archived, false);
  });

  it("purgeCard 彻底删除卡片", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const card = await store.addCard({ columnId: boardBefore.columns[0]!.id, title: "任务" });

    await store.purgeCard(card.id);
    const board = await store.loadBoard();
    assert.equal(board.cards.length, 0);
  });
});

describe("BoardStore 卡片排序与移动", () => {
  it("moveCard 跨列并把卡片插入目标列指定位置", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const todo = boardBefore.columns[0]!.id;
    const doing = boardBefore.columns[1]!.id;

    const c1 = await store.addCard({ columnId: todo, title: "c1" });
    const c2 = await store.addCard({ columnId: todo, title: "c2" });
    await store.moveCard(c1.id, { columnId: doing, toIndex: 0 });

    const board = await store.loadBoard();
    const doingCards = board.cards.filter(card => card.columnId === doing);
    assert.equal(doingCards.length, 1);
    assert.equal(doingCards[0]?.id, c1.id);
    assert.equal(
      board.cards.findIndex(card => card.id === c2.id),
      1,
    );
  });

  it("moveCard 列内重排", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const todo = boardBefore.columns[0]!.id;

    const c1 = await store.addCard({ columnId: todo, title: "c1" });
    const c2 = await store.addCard({ columnId: todo, title: "c2" });
    await store.moveCard(c2.id, { columnId: todo, toIndex: 0 });

    const board = await store.loadBoard();
    assert.equal(board.cards[0]?.id, c2.id);
    assert.equal(board.cards[1]?.id, c1.id);
  });

  it("duplicateCard 复制卡片", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const todo = boardBefore.columns[0]!.id;

    const original = await store.addCard({
      columnId: todo,
      title: "原卡",
      note: "备注",
      label: "功能",
      priority: "high",
      color: "#ff0000",
    });
    const dup = await store.duplicateCard(original.id);

    assert.notEqual(dup.id, original.id);
    assert.equal(dup.title, "原卡 (副本)");
    assert.equal(dup.note, "备注");
    assert.equal(dup.label, "功能");
    assert.equal(dup.priority, "high");
    assert.equal(dup.color, "#ff0000");
    assert.equal(dup.columnId, todo);
  });
});

describe("BoardStore 批量与跨项目", () => {
  it("bulkArchiveCards 批量软删", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const todo = boardBefore.columns[0]!.id;

    const c1 = await store.addCard({ columnId: todo, title: "1" });
    const c2 = await store.addCard({ columnId: todo, title: "2" });
    await store.bulkArchiveCards([c1.id, c2.id]);

    const board = await store.loadBoard();
    assert.ok(board.cards.every(card => card.archived));
  });

  it("bulkMoveCards 批量移动到目标列", async () => {
    const { store } = makeStore();
    const boardBefore = await store.loadBoard();
    const todo = boardBefore.columns[0]!.id;
    const doing = boardBefore.columns[1]!.id;

    const c1 = await store.addCard({ columnId: todo, title: "1" });
    const c2 = await store.addCard({ columnId: todo, title: "2" });
    await store.bulkMoveCards([c1.id, c2.id], doing);

    const board = await store.loadBoard();
    assert.ok(board.cards.every(card => card.columnId === doing));
  });

  it("moveCardToStore 把卡片移到另一项目的 BoardStore，目标项目重新生成 id", async () => {
    const { store: srcStore } = makeStore();
    const dstRoot = tempProjectRoot();
    tempDirs.push(dstRoot);
    const dstStore = new BoardStore(dstRoot);

    const boardBefore = await srcStore.loadBoard();
    const todo = boardBefore.columns[0]!.id;
    const card = await srcStore.addCard({ columnId: todo, title: "跨项目卡", note: "移过去" });

    const moved = await srcStore.moveCardToStore(card.id, dstStore);
    assert.ok(moved.id.startsWith("k"));
    assert.equal(moved.title, "跨项目卡");
    assert.equal(moved.note, "移过去");

    const srcBoard = await srcStore.loadBoard();
    assert.equal(srcBoard.cards.length, 0);

    const dstBoard = await dstStore.loadBoard();
    assert.equal(dstBoard.cards.length, 1);
    assert.equal(dstBoard.cards[0]?.id, moved.id);
    assert.equal(dstBoard.cards[0]?.columnId, dstBoard.columns[0]?.id);
    assert.equal(dstBoard.cards[0]?.source, undefined, "跨项目移动后清除 source 溯源");
  });
});

describe("BoardStore 项目隔离", () => {
  it("不同 BoardStore 实例对应不同项目根目录，互不干扰", async () => {
    const { store: storeA } = makeStore();
    const b = tempProjectRoot();
    tempDirs.push(b);
    const storeB = new BoardStore(b);

    const boardA = await storeA.loadBoard();
    await storeA.addCard({ columnId: boardA.columns[0]!.id, title: "仅A" });

    const boardB = await storeB.loadBoard();
    assert.equal(boardB.cards.length, 0);

    const reloadedA = await storeA.loadBoard();
    assert.equal(reloadedA.cards.length, 1);
    assert.equal(reloadedA.cards[0]?.title, "仅A");
  });
});
