/**
 * 项目看板（Kanban）存储层。
 *
 * - 每项目一个 `{projectRoot}/kanban-board.json`。
 * - 原子写（临时文件 + rename），损坏文件备份后重建默认三列。
 * - 列/卡 id 按项目独立 seq 递增；跨项目移动时目标项目重新生成 id。
 */

import { mkdir, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson } from "../../patent/persist-utils.js";
import type {
  BoardCard,
  BoardCardSource,
  BoardCardUpdate,
  BoardColumn,
  BoardMoveTarget,
  BoardPriority,
  BoardState,
} from "../protocol/types.js";
import { BoardStoreError } from "./errors.js";

const BOARD_FILE_NAME = "kanban-board.json";

const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: "c1", title: "待办", color: "#64748b" },
  { id: "c2", title: "进行中", color: "#f59e0b" },
  { id: "c3", title: "已完成", color: "#10b981" },
];

function createDefaultBoard(): BoardState {
  return {
    version: 1,
    columns: DEFAULT_COLUMNS.map(column => ({ ...column })),
    cards: [],
    seq: DEFAULT_COLUMNS.length,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoardPriority(value: unknown): value is BoardPriority {
  return value === "high" || value === "medium" || value === "low";
}

function isBoardColumn(value: unknown): value is BoardColumn {
  if (!isObject(value)) return false;
  const { id, title, color } = value as Record<string, unknown>;
  return typeof id === "string" && typeof title === "string" && typeof color === "string";
}

function isBoardCardSource(value: unknown): value is BoardCardSource {
  if (!isObject(value)) return false;
  const { sessionKey, turnId, at } = value as Record<string, unknown>;
  return typeof sessionKey === "string" && typeof turnId === "string" && typeof at === "string";
}

function isBoardCard(value: unknown): value is BoardCard {
  if (!isObject(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return false;
  if (typeof record.columnId !== "string") return false;
  if (typeof record.title !== "string") return false;
  if (typeof record.note !== "string") return false;
  if (typeof record.label !== "string") return false;
  if (!isBoardPriority(record.priority)) return false;
  if (typeof record.color !== "string") return false;
  if (typeof record.archived !== "boolean") return false;
  if (typeof record.createdAt !== "string") return false;
  if (typeof record.updatedAt !== "string") return false;
  if (record.dueDate !== undefined && typeof record.dueDate !== "string") return false;
  if (record.source !== undefined && !isBoardCardSource(record.source)) return false;
  return true;
}

function validateBoardState(value: unknown): BoardState {
  if (!isObject(value)) {
    throw new BoardStoreError("Board state must be an object");
  }

  const { version, columns, cards, seq } = value as Record<string, unknown>;

  if (typeof version !== "number") {
    throw new BoardStoreError("Board state.version must be a number");
  }

  if (!Array.isArray(columns) || !columns.every(isBoardColumn)) {
    throw new BoardStoreError("Board state.columns must be an array of BoardColumn");
  }

  if (!Array.isArray(cards) || !cards.every(isBoardCard)) {
    throw new BoardStoreError("Board state.cards must be an array of BoardCard");
  }

  if (typeof seq !== "number" || !Number.isInteger(seq)) {
    throw new BoardStoreError("Board state.seq must be an integer");
  }

  return { version, columns, cards, seq };
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

function nextColumnId(state: BoardState): string {
  state.seq += 1;
  return `c${state.seq}`;
}

function nextCardId(state: BoardState): string {
  state.seq += 1;
  return `k${state.seq}`;
}

export class BoardStore {
  constructor(private readonly projectRoot: string) {}

  /**
   * Mutex tail；await `mutex` 后赋新 promise 串行化同一项目内的读改写。
   * 与 `FileHistoryStore` 同款：比 AbortController 便宜，也避开 `Promise.race` 的坑。
   * 每个项目一个 `BoardStore`（经 `KanbanBoardManager` 缓存），故 store 级锁即项目级串行化。
   */
  private mutex: Promise<void> = Promise.resolve();

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(task, task);
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 在持有项目锁的前提下执行「读 → transform → 写」；transform/save 抛错则本次变更不落盘。 */
  private async mutate<T>(transform: (state: BoardState) => T | Promise<T>): Promise<T> {
    return this.run(async () => {
      const state = await this.loadBoard();
      const result = await transform(state);
      await this.saveBoard(state);
      return result;
    });
  }

  private boardPath(): string {
    return resolve(this.projectRoot, BOARD_FILE_NAME);
  }

  async saveBoard(state: BoardState): Promise<void> {
    await mkdir(this.projectRoot, { recursive: true });
    await atomicWriteJson(this.boardPath(), JSON.stringify(state, null, 2));
  }

  private async backupCorruptBoard(_reason: Error): Promise<void> {
    const boardPath = this.boardPath();
    const timestamp = Date.now();
    const backupPath = `${boardPath}.corrupt-${timestamp}`;
    await rename(boardPath, backupPath);
  }

  async loadBoard(): Promise<BoardState> {
    const boardPath = this.boardPath();
    try {
      const raw = await readFile(boardPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return validateBoardState(parsed);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        const defaultBoard = createDefaultBoard();
        await this.saveBoard(defaultBoard);
        return defaultBoard;
      }

      if (error instanceof SyntaxError || error instanceof BoardStoreError) {
        await this.backupCorruptBoard(error);
        const defaultBoard = createDefaultBoard();
        await this.saveBoard(defaultBoard);
        return defaultBoard;
      }

      throw error;
    }
  }

  private findColumnIndex(state: BoardState, columnId: string): number {
    const index = state.columns.findIndex(column => column.id === columnId);
    if (index === -1) {
      throw new BoardStoreError(`Column not found: ${columnId}`);
    }
    return index;
  }

  private findCardIndex(state: BoardState, cardId: string): number {
    const index = state.cards.findIndex(card => card.id === cardId);
    if (index === -1) {
      throw new BoardStoreError(`Card not found: ${cardId}`);
    }
    return index;
  }

  async addColumn(title: string, color = "#64748b"): Promise<BoardColumn> {
    return this.mutate(state => {
      const column: BoardColumn = { id: nextColumnId(state), title, color };
      state.columns.push(column);
      return column;
    });
  }

  async renameColumn(columnId: string, title: string): Promise<void> {
    return this.mutate(state => {
      const index = this.findColumnIndex(state, columnId);
      state.columns[index] = { ...state.columns[index]!, title };
    });
  }

  async deleteColumn(columnId: string): Promise<void> {
    return this.mutate(state => {
      if (state.columns.length <= 1) {
        throw new BoardStoreError("Cannot delete the last column");
      }

      const index = this.findColumnIndex(state, columnId);
      const [removed] = state.columns.splice(index, 1);
      const fallbackColumnId = state.columns[0]!.id;

      for (const card of state.cards) {
        if (card.columnId === removed!.id) {
          card.columnId = fallbackColumnId;
        }
      }
    });
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
    source?: BoardCardSource,
  ): Promise<BoardCard> {
    return this.mutate(state => {
      this.findColumnIndex(state, fields.columnId);

      const timestamp = nowTimestamp();
      const card: BoardCard = {
        id: nextCardId(state),
        columnId: fields.columnId,
        title: fields.title,
        note: fields.note ?? "",
        label: fields.label ?? "",
        priority: fields.priority ?? "medium",
        color: fields.color ?? "#0ea5e9",
        dueDate: fields.dueDate,
        archived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        source,
      };

      state.cards.push(card);
      return card;
    });
  }

  async updateCard(cardId: string, update: BoardCardUpdate): Promise<BoardCard> {
    return this.mutate(state => {
      const index = this.findCardIndex(state, cardId);
      const existing = state.cards[index]!;

      const updated: BoardCard = {
        ...existing,
        ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
        id: existing.id,
        columnId: existing.columnId,
        createdAt: existing.createdAt,
        updatedAt: nowTimestamp(),
      };

      state.cards[index] = updated;
      return updated;
    });
  }

  async moveCard(cardId: string, target: BoardMoveTarget): Promise<void> {
    return this.mutate(state => {
      const sourceIndex = this.findCardIndex(state, cardId);
      this.findColumnIndex(state, target.columnId);

      const [card] = state.cards.splice(sourceIndex, 1);
      card!.columnId = target.columnId;
      card!.updatedAt = nowTimestamp();

      const targetIndex =
        target.toIndex !== undefined ? Math.max(0, Math.min(target.toIndex, state.cards.length)) : state.cards.length;

      state.cards.splice(targetIndex, 0, card!);
    });
  }

  async archiveCard(cardId: string): Promise<void> {
    await this.updateCard(cardId, { archived: true });
  }

  async restoreCard(cardId: string): Promise<void> {
    await this.updateCard(cardId, { archived: false });
  }

  async purgeCard(cardId: string): Promise<void> {
    return this.mutate(state => {
      const index = this.findCardIndex(state, cardId);
      state.cards.splice(index, 1);
    });
  }

  async duplicateCard(cardId: string, target?: BoardMoveTarget): Promise<BoardCard> {
    return this.mutate(state => {
      const sourceIndex = this.findCardIndex(state, cardId);
      const original = state.cards[sourceIndex]!;

      const columnId = target?.columnId ?? original.columnId;
      this.findColumnIndex(state, columnId);

      const timestamp = nowTimestamp();
      const copy: BoardCard = {
        ...original,
        id: nextCardId(state),
        columnId,
        title: `${original.title} (副本)`,
        archived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        source: undefined,
      };

      const targetIndex =
        target?.toIndex !== undefined ? Math.max(0, Math.min(target.toIndex, state.cards.length)) : state.cards.length;

      state.cards.splice(targetIndex, 0, copy);
      return copy;
    });
  }

  async bulkArchiveCards(ids: string[]): Promise<void> {
    return this.mutate(state => {
      for (const cardId of ids) {
        const index = this.findCardIndex(state, cardId);
        state.cards[index]!.archived = true;
        state.cards[index]!.updatedAt = nowTimestamp();
      }
    });
  }

  async bulkMoveCards(ids: string[], columnId: string): Promise<void> {
    return this.mutate(state => {
      this.findColumnIndex(state, columnId);

      const movedCards: BoardCard[] = [];
      for (const cardId of ids) {
        const index = this.findCardIndex(state, cardId);
        const [card] = state.cards.splice(index, 1);
        card!.columnId = columnId;
        card!.updatedAt = nowTimestamp();
        movedCards.push(card!);
      }

      state.cards.push(...movedCards);
    });
  }

  /**
   * 把卡片移到另一个 BoardStore（对应另一个项目）。
   * 源板删除该卡，目标板按目标自己的 seq 重新生成 id 并插入第一列。
   *
   * 串行化：源板在 `this.mutex` 下、目标板在 `targetStore.mutex` 下各自执行，
   * 避免与各自项目内的并发读改写竞争（锁定序固定为源→目标，无反向，故无死锁）。
   * 落盘顺序：先目标后源。目标写失败则源板不动，卡片留在源板（不丢卡）；
   * 「目标成功、源写失败」会两板都有该卡（重复而非丢失），v1 简化，非跨文件事务。
   */
  async moveCardToStore(cardId: string, targetStore: BoardStore): Promise<BoardCard> {
    return this.mutate(async sourceState => {
      const sourceIndex = this.findCardIndex(sourceState, cardId);
      const [card] = sourceState.cards.splice(sourceIndex, 1);

      const movedCard = await targetStore.run(async () => {
        const targetState = await targetStore.loadBoard();
        const targetColumnId = targetState.columns[0]!.id;
        const moved: BoardCard = {
          ...card!,
          id: nextCardId(targetState),
          columnId: targetColumnId,
          createdAt: nowTimestamp(),
          updatedAt: nowTimestamp(),
          source: undefined,
        };
        targetState.cards.push(moved);
        await targetStore.saveBoard(targetState);
        return moved;
      });

      return movedCard;
    });
  }
}
