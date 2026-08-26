import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BoardRuntimeOptions, KanbanUpdatedPayload } from "../../src/board/protocol/types.js";
import { BoardRuntime } from "../../src/board/runtime/BoardRuntime.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-board-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function makeRuntime(
  projectRoot = tempProjectRoot(),
  overrides: Partial<BoardRuntimeOptions> = {},
): { projectRoot: string; runtime: BoardRuntime; events: KanbanUpdatedPayload[] } {
  const events: KanbanUpdatedPayload[] = [];
  const runtime = new BoardRuntime({
    projectId: projectRoot,
    projectRoot,
    emit: (_projectId, payload) => {
      events.push(payload);
    },
    ...overrides,
  });
  return { projectRoot, runtime, events };
}

describe("BoardRuntime 业务规则", () => {
  it("getBoard 返回默认三列", async () => {
    const { runtime } = makeRuntime();
    const board = await runtime.getBoard();
    assert.equal(board.columns.length, 3);
    assert.equal(board.cards.length, 0);
  });

  it("addCard 加卡并返回 cardId；未提供 actor 时不注入 source", async () => {
    const { runtime } = makeRuntime();
    const board = await runtime.getBoard();
    const card = await runtime.addCard({ columnId: board.columns[0]!.id, title: "任务" });

    assert.ok(card.id.startsWith("k"));
    assert.equal(card.title, "任务");
    assert.equal(card.source, undefined);
  });

  it("addCard 提供 actor 时注入 source", async () => {
    const { runtime } = makeRuntime();
    const board = await runtime.getBoard();
    const card = await runtime.addCard(
      { columnId: board.columns[0]!.id, title: "agent 任务" },
      { sessionKey: "s-1", turnId: "t-2" },
    );

    assert.equal(card.source?.sessionKey, "s-1");
    assert.equal(card.source?.turnId, "t-2");
  });

  it("updateCard 更新字段并触发事件", async () => {
    const { runtime, events } = makeRuntime();
    const board = await runtime.getBoard();
    const card = await runtime.addCard({ columnId: board.columns[0]!.id, title: "旧" });

    await runtime.updateCard(card.id, { title: "新" });
    const updatedBoard = await runtime.getBoard();
    assert.equal(updatedBoard.cards[0]?.title, "新");
    assert.equal(events.length, 2);
    assert.equal(events[1]?.kind, "card");
    assert.equal(events[1]?.cardId, card.id);
  });

  it("moveCard 跨列后触发事件", async () => {
    const { runtime, events } = makeRuntime();
    const board = await runtime.getBoard();
    const todo = board.columns[0]!.id;
    const doing = board.columns[1]!.id;
    const card = await runtime.addCard({ columnId: todo, title: "移动卡" });

    events.length = 0;
    await runtime.moveCard(card.id, { columnId: doing, toIndex: 0 });
    const updatedBoard = await runtime.getBoard();
    assert.equal(updatedBoard.cards[0]?.columnId, doing);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "card");
  });

  it("archiveCard / restoreCard 触发事件", async () => {
    const { runtime, events } = makeRuntime();
    const board = await runtime.getBoard();
    const card = await runtime.addCard({ columnId: board.columns[0]!.id, title: "x" });

    events.length = 0;
    await runtime.archiveCard(card.id);
    assert.equal(events[0]?.kind, "card");

    events.length = 0;
    await runtime.restoreCard(card.id);
    assert.equal(events[0]?.kind, "card");
  });

  it("deleteColumn 触发 column 事件", async () => {
    const { runtime, events } = makeRuntime();
    const board = await runtime.getBoard();
    events.length = 0;
    await runtime.deleteColumn(board.columns[2]!.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "column");
    assert.equal(events[0]?.columnId, board.columns[2]!.id);
  });

  it("addColumn 触发 column 事件", async () => {
    const { runtime, events } = makeRuntime();
    await runtime.getBoard();
    events.length = 0;
    const column = await runtime.addColumn("新列");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "column");
    assert.equal(events[0]?.columnId, column.id);
  });
});

describe("BoardRuntime undo", () => {
  it("undo 撤销最近一次写操作", async () => {
    const { runtime } = makeRuntime();
    const board = await runtime.getBoard();
    const card = await runtime.addCard({ columnId: board.columns[0]!.id, title: "要撤销" });

    await runtime.undo();
    const after = await runtime.getBoard();
    assert.equal(after.cards.length, 0);

    // 撤销后再 redo 不在 v1 范围，只能再次写入；seq 恢复到原状，id 会复用。
    const readded = await runtime.addCard({ columnId: board.columns[0]!.id, title: "重加" });
    assert.equal(readded.id, card.id);
    assert.equal(readded.title, "重加");
  });

  it("undo 最多保留 50 步", async () => {
    const { runtime } = makeRuntime();
    const board = await runtime.getBoard();
    const columnId = board.columns[0]!.id;

    // 生成 55 次写操作，undo 栈只保留最近 50 步。
    for (let i = 0; i < 55; i += 1) {
      await runtime.addCard({ columnId, title: `card-${i}` });
    }

    const current = await runtime.getBoard();
    assert.equal(current.cards.length, 55);

    for (let i = 0; i < 50; i += 1) {
      await runtime.undo();
    }

    const after = await runtime.getBoard();
    assert.equal(after.cards.length, 5);
  });

  it("undo 对不可撤销操作（如 getBoard）不增长栈", async () => {
    const { runtime } = makeRuntime();
    await runtime.getBoard();
    await runtime.undo();
    const board = await runtime.getBoard();
    assert.equal(board.columns.length, 3);
  });

  it("undo 触发 board 类型事件，通知订阅者重建", async () => {
    const { runtime, events } = makeRuntime();
    const board = await runtime.getBoard();
    await runtime.addCard({ columnId: board.columns[0]!.id, title: "要撤销" });

    events.length = 0;
    await runtime.undo();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "board");
  });
});

describe("BoardRuntime 跨项目移动", () => {
  it("moveCardToProject 在源和目标分别触发事件", async () => {
    const { runtime: srcRuntime, events: srcEvents } = makeRuntime();
    const dstRoot = tempProjectRoot();
    const { runtime: dstRuntime, events: dstEvents } = makeRuntime(dstRoot);

    const board = await srcRuntime.getBoard();
    const card = await srcRuntime.addCard({ columnId: board.columns[0]!.id, title: "跨项目" });

    srcEvents.length = 0;
    dstEvents.length = 0;
    await srcRuntime.moveCardToProject(card.id, dstRuntime);

    assert.equal(srcEvents.length, 1);
    assert.equal(srcEvents[0]?.kind, "card");

    assert.equal(dstEvents.length, 1);
    assert.equal(dstEvents[0]?.kind, "card");

    const dstBoard = await dstRuntime.getBoard();
    assert.equal(dstBoard.cards.length, 1);
    assert.equal(dstBoard.cards[0]?.title, "跨项目");
  });
});

describe("BoardRuntime 项目隔离", () => {
  it("不同 runtime 操作不同项目互不干扰", async () => {
    const { runtime: runtimeA } = makeRuntime();
    const { runtime: runtimeB } = makeRuntime();

    const boardA = await runtimeA.getBoard();
    await runtimeA.addCard({ columnId: boardA.columns[0]!.id, title: "A" });

    const boardB = await runtimeB.getBoard();
    assert.equal(boardB.cards.length, 0);

    const reloadedA = await runtimeA.getBoard();
    assert.equal(reloadedA.cards.length, 1);
  });
});
