/**
 * 项目看板（Kanban）agent 工具集。
 *
 * 与 UI 共用 `KanbanBoardManager` 缓存的 `BoardRuntime`，保证 agent 写卡后
 * 同一项目的看板订阅者能收到 `kanban_updated` 事件。
 */
import { resolve } from "node:path";
import type { BoardCard, BoardColumn, BoardPriority, BoardState } from "../../board/protocol/types.js";
import { KanbanBoardManager } from "../../gateway/kanban/KanbanBoardManager.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../protocol/types.js";

export type KanbanGetInput = {
  includeArchived?: boolean;
};

export type KanbanGetOutput = {
  columns: Array<{ id: string; title: string; color: string }>;
  cards: Array<{
    id: string;
    columnId: string;
    title: string;
    note: string;
    label: string;
    priority: BoardPriority;
    color: string;
    dueDate?: string;
    archived: boolean;
    source?: { sessionKey: string; turnId: string; at: string };
  }>;
};

export type KanbanAddCardInput = {
  title: string;
  columnId?: string;
  note?: string;
  label?: string;
  priority?: BoardPriority;
  color?: string;
  dueDate?: string;
};

export type KanbanAddCardOutput = { cardId: string; columnId: string; title: string };

export type KanbanUpdateCardInput = {
  id: string;
  title?: string;
  note?: string;
  label?: string;
  priority?: BoardPriority;
  color?: string;
  dueDate?: string;
};

export type KanbanUpdateCardOutput = { cardId: string; updatedAt: string };

export type KanbanCardIdInput = { id: string };
export type KanbanOkOutput = { ok: true };

export type KanbanBulkCardsInput = { ids: string[] };
export type KanbanBulkMoveCardsInput = { ids: string[]; columnId: string };
export type KanbanAffectedOutput = { ok: true; affected: number };

export type KanbanMoveCardInput = { id: string; columnId: string; toIndex?: number };

export type KanbanDuplicateCardInput = { id: string; columnId?: string; toIndex?: number };
export type KanbanDuplicateCardOutput = { cardId: string; columnId: string; title: string };

export type KanbanMoveCardToWorkspaceInput = { id: string; toWorkspaceId: string };
export type KanbanMoveCardToWorkspaceOutput = { cardId: string };

export type KanbanAddColumnInput = { title: string; color?: string };
export type KanbanAddColumnOutput = { columnId: string; title: string };

export type KanbanRenameColumnInput = { id: string; title: string };

export type KanbanColumnIdInput = { id: string };

export type KanbanUndoInput = Record<string, never>;

function summaryColumn(column: BoardColumn): KanbanGetOutput["columns"][number] {
  return { id: column.id, title: column.title, color: column.color };
}

function summaryCard(card: BoardCard): KanbanGetOutput["cards"][number] {
  return {
    id: card.id,
    columnId: card.columnId,
    title: card.title,
    note: card.note,
    label: card.label,
    priority: card.priority,
    color: card.color,
    dueDate: card.dueDate,
    archived: card.archived,
    source: card.source,
  };
}

function summarizeBoard(state: BoardState, includeArchived: boolean): KanbanGetOutput {
  return {
    columns: state.columns.map(summaryColumn),
    cards: state.cards.filter(card => includeArchived || !card.archived).map(summaryCard),
  };
}

function getRuntime(manager: KanbanBoardManager, cwd: string) {
  const projectRoot = resolve(cwd);
  return manager.getRuntime(projectRoot, projectRoot);
}

function actorFrom(context: { sessionId: string; turnId: string }) {
  return { sessionKey: context.sessionId, turnId: context.turnId };
}

/** 把 `BoardStoreError` 等运行时异常转换为结构化的 tool 错误。 */
async function wrapRuntimeError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SatiToolRuntimeError("tool_execution_failed", `kanban operation failed: ${message}`);
  }
}

export function createKanbanGetTool(manager: KanbanBoardManager): SatiToolDefinition<KanbanGetInput, KanbanGetOutput> {
  return {
    name: "kanban_get",
    description:
      "Read the current project's kanban board summary. Returns columns and visible cards. Use this before planning or updating the board.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeArchived: {
          type: "boolean",
          description: "Include archived (soft-deleted) cards in the result. Defaults to false.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["columns", "cards"],
      additionalProperties: false,
      properties: {
        columns: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "color"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              color: { type: "string" },
            },
          },
        },
        cards: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "columnId", "title", "note", "label", "priority", "color", "archived"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              columnId: { type: "string" },
              title: { type: "string" },
              note: { type: "string" },
              label: { type: "string" },
              priority: { type: "string", enum: ["high", "medium", "low"] },
              color: { type: "string" },
              dueDate: { type: "string" },
              archived: { type: "boolean" },
              source: {
                type: "object",
                required: ["sessionKey", "turnId", "at"],
                additionalProperties: false,
                properties: {
                  sessionKey: { type: "string" },
                  turnId: { type: "string" },
                  at: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      const state = await wrapRuntimeError(() => runtime.getBoard());
      const includeArchived = input.includeArchived ?? false;
      const output = summarizeBoard(state, includeArchived);
      return {
        content: [
          {
            type: "text",
            text: formatBoardText(output),
          },
        ],
        data: output,
      };
    },
  };
}

export function createKanbanAddCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanAddCardInput, KanbanAddCardOutput> {
  return {
    name: "kanban_add_card",
    description:
      "Add a new card to the current project's kanban board. If columnId is omitted, the card is placed in the first column. Records the calling session/turn as the source.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Card title." },
        columnId: { type: "string", description: "Target column id. Defaults to the first column." },
        note: { type: "string", description: "Optional details or acceptance criteria." },
        label: { type: "string", description: "Optional label such as feature / bug / docs / optimization." },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Card priority. Defaults to medium.",
        },
        color: { type: "string", description: "Optional hex color (#rrggbb)." },
        dueDate: { type: "string", description: "Optional due date (YYYY-MM-DD)." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["cardId", "columnId", "title"],
      additionalProperties: false,
      properties: {
        cardId: { type: "string" },
        columnId: { type: "string" },
        title: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      const state = await wrapRuntimeError(() => runtime.getBoard());
      const columnId = input.columnId ?? state.columns[0]?.id;
      if (columnId === undefined) {
        throw new SatiToolRuntimeError("tool_execution_failed", "kanban_add_card: board has no columns");
      }
      const card = await wrapRuntimeError(() =>
        runtime.addCard(
          {
            columnId,
            title: input.title,
            note: input.note,
            label: input.label,
            priority: input.priority,
            color: input.color,
            dueDate: input.dueDate,
          },
          actorFrom(context),
        ),
      );
      const output: KanbanAddCardOutput = { cardId: card.id, columnId: card.columnId, title: card.title };
      return {
        content: [{ type: "text", text: `Added card ${output.cardId} to column ${output.columnId}: ${output.title}` }],
        data: output,
      };
    },
  };
}

export function createKanbanUpdateCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanUpdateCardInput, KanbanUpdateCardOutput> {
  return {
    name: "kanban_update_card",
    description: "Update one or more fields of an existing card on the current project's kanban board.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to update." },
        title: { type: "string", description: "New title." },
        note: { type: "string", description: "New note." },
        label: { type: "string", description: "New label." },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "New priority.",
        },
        color: { type: "string", description: "New hex color (#rrggbb)." },
        dueDate: { type: "string", description: "New due date (YYYY-MM-DD)." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["cardId", "updatedAt"],
      additionalProperties: false,
      properties: {
        cardId: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      const card = await wrapRuntimeError(() =>
        runtime.updateCard(input.id, {
          title: input.title,
          note: input.note,
          label: input.label,
          priority: input.priority,
          color: input.color,
          dueDate: input.dueDate,
        }),
      );
      const output: KanbanUpdateCardOutput = { cardId: card.id, updatedAt: card.updatedAt };
      return {
        content: [{ type: "text", text: `Updated card ${output.cardId} at ${output.updatedAt}` }],
        data: output,
      };
    },
  };
}

export function createKanbanDeleteCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanCardIdInput, KanbanOkOutput> {
  return {
    name: "kanban_delete_card",
    description: "Soft-delete a card (move it to the archive). Use kanban_restore_card to undo.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to archive." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.archiveCard(input.id));
      return okOutput(`Archived card ${input.id}`);
    },
  };
}

export function createKanbanRestoreCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanCardIdInput, KanbanOkOutput> {
  return {
    name: "kanban_restore_card",
    description: "Restore an archived card to the board.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to restore." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.restoreCard(input.id));
      return okOutput(`Restored card ${input.id}`);
    },
  };
}

export function createKanbanPurgeCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanCardIdInput, KanbanOkOutput> {
  return {
    name: "kanban_purge_card",
    description: "Permanently delete a card. This cannot be undone.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to permanently delete." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.purgeCard(input.id));
      return okOutput(`Purged card ${input.id}`);
    },
  };
}

export function createKanbanBulkDeleteCardsTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanBulkCardsInput, KanbanAffectedOutput> {
  return {
    name: "kanban_bulk_delete_cards",
    description: "Archive multiple cards at once.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["ids"],
      additionalProperties: false,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Card ids to archive.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok", "affected"],
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        affected: { type: "integer" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.bulkArchiveCards(input.ids));
      return affectedOutput(input.ids.length, `Archived ${input.ids.length} cards`);
    },
  };
}

export function createKanbanBulkMoveCardsTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanBulkMoveCardsInput, KanbanAffectedOutput> {
  return {
    name: "kanban_bulk_move_cards",
    description: "Move multiple cards to the same target column at once.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["ids", "columnId"],
      additionalProperties: false,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Card ids to move.",
        },
        columnId: { type: "string", description: "Target column id." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok", "affected"],
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        affected: { type: "integer" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.bulkMoveCards(input.ids, input.columnId));
      return affectedOutput(input.ids.length, `Moved ${input.ids.length} cards to column ${input.columnId}`);
    },
  };
}

export function createKanbanMoveCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanMoveCardInput, KanbanOkOutput> {
  return {
    name: "kanban_move_card",
    description:
      "Move a card to another column or reorder it within the same column. Use toIndex to control the insertion position.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id", "columnId"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to move." },
        columnId: { type: "string", description: "Target column id." },
        toIndex: {
          type: "integer",
          description: "Insertion index within the target column. Omit to append to the end.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.moveCard(input.id, { columnId: input.columnId, toIndex: input.toIndex }));
      return okOutput(`Moved card ${input.id} to column ${input.columnId}`);
    },
  };
}

export function createKanbanDuplicateCardTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanDuplicateCardInput, KanbanDuplicateCardOutput> {
  return {
    name: "kanban_duplicate_card",
    description: "Duplicate an existing card. The copy gets a new id and title suffix.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to duplicate." },
        columnId: { type: "string", description: "Target column id. Defaults to the original card's column." },
        toIndex: {
          type: "integer",
          description: "Insertion index within the target column. Omit to append to the end.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["cardId", "columnId", "title"],
      additionalProperties: false,
      properties: {
        cardId: { type: "string" },
        columnId: { type: "string" },
        title: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      const target = input.columnId !== undefined ? { columnId: input.columnId, toIndex: input.toIndex } : undefined;
      const card = await wrapRuntimeError(() => runtime.duplicateCard(input.id, target));
      const output: KanbanDuplicateCardOutput = {
        cardId: card.id,
        columnId: card.columnId,
        title: card.title,
      };
      return {
        content: [{ type: "text", text: `Duplicated card ${input.id} to ${output.cardId}: ${output.title}` }],
        data: output,
      };
    },
  };
}

export function createKanbanMoveCardToWorkspaceTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanMoveCardToWorkspaceInput, KanbanMoveCardToWorkspaceOutput> {
  return {
    name: "kanban_move_card_to_workspace",
    description:
      "Move a card from the current project to another project. The card gets a new id in the target project.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id", "toWorkspaceId"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Card id to move." },
        toWorkspaceId: {
          type: "string",
          description: "Target project root path or project identifier.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["cardId"],
      additionalProperties: false,
      properties: { cardId: { type: "string" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const sourceRuntime = getRuntime(manager, context.cwd);
      const targetProjectRoot = resolve(input.toWorkspaceId);
      const targetRuntime = manager.getRuntime(targetProjectRoot, targetProjectRoot);
      const card = await wrapRuntimeError(() => sourceRuntime.moveCardToProject(input.id, targetRuntime));
      const output: KanbanMoveCardToWorkspaceOutput = { cardId: card.id };
      return {
        content: [{ type: "text", text: `Moved card ${input.id} to project ${input.toWorkspaceId} as ${card.id}` }],
        data: output,
      };
    },
  };
}

export function createKanbanAddColumnTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanAddColumnInput, KanbanAddColumnOutput> {
  return {
    name: "kanban_add_column",
    description: "Add a new column to the current project's kanban board.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Column title." },
        color: { type: "string", description: "Optional hex color (#rrggbb). Defaults to slate." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["columnId", "title"],
      additionalProperties: false,
      properties: {
        columnId: { type: "string" },
        title: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      const column = await wrapRuntimeError(() => runtime.addColumn(input.title, input.color));
      const output: KanbanAddColumnOutput = { columnId: column.id, title: column.title };
      return {
        content: [{ type: "text", text: `Added column ${output.columnId}: ${output.title}` }],
        data: output,
      };
    },
  };
}

export function createKanbanRenameColumnTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanRenameColumnInput, KanbanOkOutput> {
  return {
    name: "kanban_rename_column",
    description: "Rename an existing column.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id", "title"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Column id to rename." },
        title: { type: "string", description: "New column title." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.renameColumn(input.id, input.title));
      return okOutput(`Renamed column ${input.id} to "${input.title}"`);
    },
  };
}

export function createKanbanDeleteColumnTool(
  manager: KanbanBoardManager,
): SatiToolDefinition<KanbanColumnIdInput, KanbanOkOutput> {
  return {
    name: "kanban_delete_column",
    description: "Delete a column and move its cards to the first remaining column.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Column id to delete." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.deleteColumn(input.id));
      return okOutput(`Deleted column ${input.id}`);
    },
  };
}

export function createKanbanUndoTool(manager: KanbanBoardManager): SatiToolDefinition<KanbanUndoInput, KanbanOkOutput> {
  return {
    name: "kanban_undo",
    description: "Undo the most recent kanban write operation in the current project.",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (_input, context) => {
      const runtime = getRuntime(manager, context.cwd);
      await wrapRuntimeError(() => runtime.undo());
      return okOutput("Undid the last kanban write operation");
    },
  };
}

function okOutput(text: string): SatiToolExecutionOutput<KanbanOkOutput> {
  return {
    content: [{ type: "text", text }],
    data: { ok: true },
  };
}

function affectedOutput(affected: number, text: string): SatiToolExecutionOutput<KanbanAffectedOutput> {
  return {
    content: [{ type: "text", text }],
    data: { ok: true, affected },
  };
}

function formatBoardText(output: KanbanGetOutput): string {
  const lines: string[] = [];
  lines.push(`Kanban board: ${output.columns.length} columns, ${output.cards.length} cards`);
  for (const column of output.columns) {
    const columnCards = output.cards.filter(card => card.columnId === column.id);
    lines.push(`\n[${column.title}] (${columnCards.length} cards)`);
    for (const card of columnCards) {
      const meta = [card.priority, card.label].filter(Boolean).join(" | ");
      const archived = card.archived ? " [archived]" : "";
      lines.push(`- ${card.id}: ${card.title}${meta ? ` (${meta})` : ""}${archived}`);
    }
  }
  return lines.join("\n");
}
