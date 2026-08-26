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

export class BoardStore {
  constructor(private readonly projectRoot: string) {}

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

  private nextColumnId(state: BoardState): string {
    state.seq += 1;
    return `c${state.seq}`;
  }

  private nextCardId(state: BoardState): string {
    state.seq += 1;
    return `k${state.seq}`;
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
    const state = await this.loadBoard();
    const column: BoardColumn = { id: this.nextColumnId(state), title, color };
    state.columns.push(column);
    await this.saveBoard(state);
    return column;
  }

  async renameColumn(columnId: string, title: string): Promise<void> {
    const state = await this.loadBoard();
    const index = this.findColumnIndex(state, columnId);
    state.columns[index] = { ...state.columns[index]!, title };
    await this.saveBoard(state);
  }

  async deleteColumn(columnId: string): Promise<void> {
    const state = await this.loadBoard();
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

    await this.saveBoard(state);
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
    const state = await this.loadBoard();
    this.findColumnIndex(state, fields.columnId);

    const timestamp = nowTimestamp();
    const card: BoardCard = {
      id: this.nextCardId(state),
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
    await this.saveBoard(state);
    return card;
  }

  async updateCard(cardId: string, update: BoardCardUpdate): Promise<BoardCard> {
    const state = await this.loadBoard();
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
    await this.saveBoard(state);
    return updated;
  }

  async moveCard(cardId: string, target: BoardMoveTarget): Promise<void> {
    const state = await this.loadBoard();
    const sourceIndex = this.findCardIndex(state, cardId);
    this.findColumnIndex(state, target.columnId);

    const [card] = state.cards.splice(sourceIndex, 1);
    card!.columnId = target.columnId;
    card!.updatedAt = nowTimestamp();

    const targetIndex =
      target.toIndex !== undefined ? Math.max(0, Math.min(target.toIndex, state.cards.length)) : state.cards.length;

    state.cards.splice(targetIndex, 0, card!);
    await this.saveBoard(state);
  }

  async archiveCard(cardId: string): Promise<void> {
    await this.updateCard(cardId, { archived: true });
  }

  async restoreCard(cardId: string): Promise<void> {
    await this.updateCard(cardId, { archived: false });
  }

  async purgeCard(cardId: string): Promise<void> {
    const state = await this.loadBoard();
    const index = this.findCardIndex(state, cardId);
    state.cards.splice(index, 1);
    await this.saveBoard(state);
  }

  async duplicateCard(cardId: string, target?: BoardMoveTarget): Promise<BoardCard> {
    const state = await this.loadBoard();
    const sourceIndex = this.findCardIndex(state, cardId);
    const original = state.cards[sourceIndex]!;

    const columnId = target?.columnId ?? original.columnId;
    this.findColumnIndex(state, columnId);

    const timestamp = nowTimestamp();
    const copy: BoardCard = {
      ...original,
      id: this.nextCardId(state),
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
    await this.saveBoard(state);
    return copy;
  }

  async bulkArchiveCards(ids: string[]): Promise<void> {
    const state = await this.loadBoard();
    for (const cardId of ids) {
      const index = this.findCardIndex(state, cardId);
      state.cards[index]!.archived = true;
      state.cards[index]!.updatedAt = nowTimestamp();
    }
    await this.saveBoard(state);
  }

  async bulkMoveCards(ids: string[], columnId: string): Promise<void> {
    const state = await this.loadBoard();
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
    await this.saveBoard(state);
  }

  /**
   * 把卡片移到另一个 BoardStore（对应另一个项目）。
   * 源板删除该卡，目标板按目标自己的 seq 重新生成 id 并插入第一列。
   */
  async moveCardToStore(cardId: string, targetStore: BoardStore): Promise<BoardCard> {
    const sourceState = await this.loadBoard();
    const sourceIndex = this.findCardIndex(sourceState, cardId);
    const [card] = sourceState.cards.splice(sourceIndex, 1);

    const targetState = await targetStore.loadBoard();
    const targetColumnId = targetState.columns[0]!.id;
    const movedCard: BoardCard = {
      ...card!,
      id: `k${targetState.seq + 1}`,
      columnId: targetColumnId,
      createdAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
      source: undefined,
    };
    targetState.seq += 1;
    targetState.cards.push(movedCard);

    await Promise.all([this.saveBoard(sourceState), targetStore.saveBoard(targetState)]);
    return movedCard;
  }
}
