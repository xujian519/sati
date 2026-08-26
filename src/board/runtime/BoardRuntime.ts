/**
 * 项目看板（Kanban）领域运行时。
 *
 * - 包装单个项目的 `BoardStore`，提供业务规则层。
 * - 为 agent 写入注入 `source.{sessionKey,turnId}` 溯源。
 * - 每次写操作成功后通过注入的 `emit` 回调触发 `kanban_updated` 事件。
 * - 维护最多 50 步的 undo 快照栈。
 */

import type {
  BoardActor,
  BoardCard,
  BoardCardUpdate,
  BoardColumn,
  BoardMoveTarget,
  BoardPriority,
  BoardRuntimeOptions,
  BoardState,
  KanbanUpdatedKind,
  KanbanUpdatedPayload,
} from "../protocol/types.js";
import { BoardStore } from "../storage/BoardStore.js";

export class BoardRuntime {
  private readonly store: BoardStore;

  private readonly projectId: string;

  private readonly emit?: (projectId: string, payload: KanbanUpdatedPayload) => void | Promise<void>;

  private readonly now: () => Date;

  private readonly maxUndoSteps: number;

  private readonly undoStack: BoardState[] = [];

  constructor(options: BoardRuntimeOptions) {
    this.projectId = options.projectId;
    this.store = new BoardStore(options.projectRoot);
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date());
    this.maxUndoSteps = options.maxUndoSteps ?? 50;
  }

  private makeSource(actor?: BoardActor): { sessionKey: string; turnId: string; at: string } | undefined {
    if (actor === undefined) return undefined;
    return { sessionKey: actor.sessionKey, turnId: actor.turnId, at: this.now().toISOString() };
  }

  private snapshot(state: BoardState): BoardState {
    return structuredClone(state);
  }

  private pushUndo(state: BoardState): void {
    this.undoStack.push(this.snapshot(state));
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
  }

  private async beforeMutation(): Promise<BoardState> {
    const state = await this.store.loadBoard();
    this.pushUndo(state);
    return state;
  }

  private async emitChange(kind: KanbanUpdatedKind, id?: { cardId?: string; columnId?: string }): Promise<void> {
    const payload: KanbanUpdatedPayload = {
      projectId: this.projectId,
      kind,
      at: this.now().toISOString(),
      ...id,
    };
    await Promise.resolve(this.emit?.(this.projectId, payload));
  }

  async getBoard(): Promise<BoardState> {
    return this.store.loadBoard();
  }

  async addColumn(title: string, color?: string): Promise<BoardColumn> {
    await this.beforeMutation();
    const column = await this.store.addColumn(title, color);
    await this.emitChange("column", { columnId: column.id });
    return column;
  }

  async renameColumn(columnId: string, title: string): Promise<void> {
    await this.beforeMutation();
    await this.store.renameColumn(columnId, title);
    await this.emitChange("column", { columnId });
  }

  async deleteColumn(columnId: string): Promise<void> {
    await this.beforeMutation();
    await this.store.deleteColumn(columnId);
    await this.emitChange("column", { columnId });
  }

  async addCard(
    fields: {
      columnId: string;
      title: string;
      note?: string;
      label?: string;
      priority?: BoardPriority;
      color?: string;
      dueDate?: string;
    },
    actor?: BoardActor,
  ): Promise<BoardCard> {
    await this.beforeMutation();
    const source = this.makeSource(actor);
    const card = await this.store.addCard(fields, source);
    await this.emitChange("card", { cardId: card.id });
    return card;
  }

  async updateCard(cardId: string, update: BoardCardUpdate): Promise<BoardCard> {
    await this.beforeMutation();
    const card = await this.store.updateCard(cardId, update);
    await this.emitChange("card", { cardId: card.id });
    return card;
  }

  async moveCard(cardId: string, target: BoardMoveTarget): Promise<void> {
    await this.beforeMutation();
    await this.store.moveCard(cardId, target);
    await this.emitChange("card", { cardId });
  }

  async archiveCard(cardId: string): Promise<void> {
    await this.beforeMutation();
    await this.store.archiveCard(cardId);
    await this.emitChange("card", { cardId });
  }

  async restoreCard(cardId: string): Promise<void> {
    await this.beforeMutation();
    await this.store.restoreCard(cardId);
    await this.emitChange("card", { cardId });
  }

  async purgeCard(cardId: string): Promise<void> {
    await this.beforeMutation();
    await this.store.purgeCard(cardId);
    await this.emitChange("card", { cardId });
  }

  async duplicateCard(cardId: string, target?: BoardMoveTarget): Promise<BoardCard> {
    await this.beforeMutation();
    const card = await this.store.duplicateCard(cardId, target);
    await this.emitChange("card", { cardId: card.id });
    return card;
  }

  async bulkArchiveCards(ids: string[]): Promise<void> {
    await this.beforeMutation();
    await this.store.bulkArchiveCards(ids);
    await this.emitChange("card");
  }

  async bulkMoveCards(ids: string[], columnId: string): Promise<void> {
    await this.beforeMutation();
    await this.store.bulkMoveCards(ids, columnId);
    await this.emitChange("card");
  }

  /**
   * 跨项目移动。源项目与目标项目各触发一次 `kanban_updated`。
   * 目标项目会重新生成卡片 id。跨项目移动不入 undo 栈（v1 限制）。
   */
  async moveCardToProject(cardId: string, targetRuntime: BoardRuntime): Promise<BoardCard> {
    // 跨项目移动：取目标 store 作为写入目标，但直接使用源 store 的 moveCardToStore。
    // 为了触发目标项目事件，由目标 runtime 包装 store 并自行 emit。
    const targetStore = targetRuntime.store;
    const moved = await this.store.moveCardToStore(cardId, targetStore);

    await this.emitChange("card", { cardId });
    await targetRuntime.emitChange("card", { cardId: moved.id });
    return moved;
  }

  async undo(): Promise<void> {
    const previous = this.undoStack.pop();
    if (previous === undefined) {
      return;
    }
    await this.store.saveBoard(this.snapshot(previous));
    // undo 恢复整板快照，用 "board" 类型通知订阅者重建（避免 UI 停留在过期卡片）。
    await this.emitChange("board");
  }
}
