/**
 * Gateway `kanban_*` 方法的 wire 类型。
 *
 * 这些类型描述 UI/工具与 gateway 之间的请求/响应契约；
 * 底层数据模型仍复用 `src/board/protocol/types.js`。
 */

import type { BoardCard, BoardColumn, BoardState, BoardPriority, BoardMoveTarget } from "../../board/protocol/types.js";

export type KanbanGetInput = {
  /** 项目标识；gateway 会把它解析为项目根目录。 */
  projectKey: string;
  includeArchived?: boolean;
};

export type KanbanError = { code: string; message: string };

export type KanbanGetResult = BoardState & { error?: KanbanError };

export type KanbanAddCardInput = {
  projectKey: string;
  columnId: string;
  title: string;
  note?: string;
  label?: string;
  priority?: BoardPriority;
  color?: string;
  dueDate?: string;
};

export type KanbanAddCardResult = { card: BoardCard | null; error?: KanbanError };

export type KanbanUpdateCardInput = {
  projectKey: string;
  cardId: string;
  title?: string;
  note?: string;
  label?: string;
  priority?: BoardPriority;
  color?: string;
  dueDate?: string;
};

export type KanbanUpdateCardResult = { card: BoardCard | null; error?: KanbanError };

export type KanbanMoveCardInput = {
  projectKey: string;
  cardId: string;
} & BoardMoveTarget;

export type KanbanMoveCardResult = { ok: boolean; error?: KanbanError };

export type KanbanArchiveCardInput = { projectKey: string; cardId: string };
export type KanbanRestoreCardInput = { projectKey: string; cardId: string };
export type KanbanPurgeCardInput = { projectKey: string; cardId: string };
export type KanbanArchiveCardResult = { ok: boolean; error?: KanbanError };
export type KanbanRestoreCardResult = { ok: boolean; error?: KanbanError };
export type KanbanPurgeCardResult = { ok: boolean; error?: KanbanError };

export type KanbanBulkArchiveCardsInput = { projectKey: string; ids: string[] };
export type KanbanBulkMoveCardsInput = { projectKey: string; ids: string[]; columnId: string };
export type KanbanBulkArchiveCardsResult = { ok: boolean; error?: KanbanError };
export type KanbanBulkMoveCardsResult = { ok: boolean; error?: KanbanError };

export type KanbanDuplicateCardInput = {
  projectKey: string;
  cardId: string;
} & Partial<BoardMoveTarget>;

export type KanbanDuplicateCardResult = { card: BoardCard | null; error?: KanbanError };

export type KanbanMoveCardToProjectInput = {
  projectKey: string;
  cardId: string;
  toProjectKey: string;
};

export type KanbanMoveCardToProjectResult = { card: BoardCard | null; error?: KanbanError };

export type KanbanAddColumnInput = { projectKey: string; title: string; color?: string };
export type KanbanAddColumnResult = { column: BoardColumn | null; error?: KanbanError };

export type KanbanRenameColumnInput = { projectKey: string; columnId: string; title: string };
export type KanbanRenameColumnResult = { ok: boolean; error?: KanbanError };

export type KanbanDeleteColumnInput = { projectKey: string; columnId: string };
export type KanbanDeleteColumnResult = { ok: boolean; error?: KanbanError };

export type KanbanReorderColumnsInput = { projectKey: string; columnIds: string[] };
export type KanbanReorderColumnsResult = { ok: boolean; error?: KanbanError };

export type KanbanUndoInput = { projectKey: string };
export type KanbanUndoResult = { ok: boolean; error?: KanbanError };

export type KanbanSubscribeInput = { projectId: string };
export type KanbanUnsubscribeInput = { projectId: string };
export type KanbanSubscribeResult = { subscribed: true };
export type KanbanUnsubscribeResult = { unsubscribed: true };
