import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowLeft, Plus, Undo2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import type { Project } from "../../../types/app";
import { useBoardDragDrop } from "../hooks/useBoardDragDrop";
import { useBoardState } from "../hooks/useBoardState";
import { cardsByColumn } from "../utils/boardPosition";
import { DEFAULT_COLUMN_COLOR } from "../constants/constants";
import type { BoardCard } from "../types/types";
import { KanbanCard } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCardEditor, type KanbanCardDraft } from "./KanbanCardEditor";

type KanbanBoardViewProps = {
  selectedProject: Project | null;
  projects: Project[];
  onOpenSession?: (sessionKey: string) => void;
};

type EditorState = { card: BoardCard | null; columnId: string } | null;

export function KanbanBoardView({ selectedProject, projects, onOpenSession }: KanbanBoardViewProps) {
  const { t } = useTranslation();
  const projectKey = selectedProject?.path || selectedProject?.fullPath || null;
  const { board, loading, error, refresh, ...actions } = useBoardState({ projectKey });
  const [editor, setEditor] = useState<EditorState>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState("");

  const visibleCards = useMemo(() => {
    if (!board) return [];
    return showArchived ? board.cards.filter(card => card.archived) : board.cards.filter(card => !card.archived);
  }, [board, showArchived]);

  const { activeCard, dndContextProps } = useBoardDragDrop({
    // 用全量 cards 计算 toIndex：拖拽 hook 的 dropToGlobalIndex 必须与服务端
    // moveCard / 乐观更新 applyMove 处于同一索引空间（归档卡被过滤后索引会偏移）。
    cards: board?.cards ?? [],
    columns: board?.columns ?? [],
    onDrop: (cardId, target) => {
      void actions.moveCard(cardId, target.columnId, target.toIndex);
    },
    onReorderColumns: columnIds => {
      void actions.reorderColumns(columnIds);
    },
  });

  const archivedCount = board ? board.cards.filter(card => card.archived).length : 0;

  const handleSaveEditor = async (draft: KanbanCardDraft) => {
    if (editor?.card) {
      return actions.updateCard(editor.card.id, {
        title: draft.title,
        note: draft.note,
        label: draft.label,
        priority: draft.priority,
        color: draft.color,
        dueDate: draft.dueDate,
      });
    }
    return actions.addCard(draft);
  };

  const handleAddColumn = async () => {
    const title = newColumnTitle.trim();
    if (!title) {
      setAddingColumn(false);
      return;
    }
    setAddingColumn(false);
    setNewColumnTitle("");
    await actions.addColumn(title, DEFAULT_COLUMN_COLOR);
  };

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
        {t("kanban:requireProject", { defaultValue: "请选择一个项目以查看其看板" })}
      </div>
    );
  }

  if (loading && !board) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
      </div>
    );
  }

  if (error && !board) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t("retry", { defaultValue: "重试" })}
        </Button>
      </div>
    );
  }

  if (!board) return null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 看板头 */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          {t("kanban:boardTitle", { defaultValue: "项目看板" })}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void actions.undo()}
          aria-label={t("kanban:undo", { defaultValue: "撤销" })}
          title={t("kanban:undo", { defaultValue: "撤销" })}
        >
          <Undo2 className="h-4 w-4" />
          {t("kanban:undo", { defaultValue: "撤销" })}
        </Button>
        <Button
          variant={showArchived ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowArchived(open => !open)}
          aria-pressed={showArchived}
        >
          {showArchived ? <ArrowLeft className="h-4 w-4" /> : null}
          {t("kanban:recycleBin", { defaultValue: "回收站" })}
          {archivedCount > 0 ? (
            <span className="rounded bg-neutral-200/70 px-1.5 text-[11px] dark:bg-neutral-800">{archivedCount}</span>
          ) : null}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAddingColumn(true)}>
          <Plus className="h-4 w-4" />
          {t("kanban:addColumn.title", { defaultValue: "新建列" })}
        </Button>
      </div>

      {/* 看板主体 */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        <DndContext {...dndContextProps}>
          <SortableContext items={board.columns.map(column => column.id)} strategy={horizontalListSortingStrategy}>
            {board.columns.map(column => (
              <KanbanColumn
                key={column.id}
                column={column}
                cards={cardsByColumn(visibleCards, column.id)}
                onOpenCard={card => setEditor({ card, columnId: card.columnId })}
                onOpenSource={onOpenSession ? card => onOpenSession(card.source?.sessionKey ?? "") : undefined}
                onAddCard={columnId => setEditor({ card: null, columnId })}
                onRenameColumn={(columnId, title) => void actions.renameColumn(columnId, title)}
                onDeleteColumn={columnId => void actions.deleteColumn(columnId)}
              />
            ))}
          </SortableContext>

          {addingColumn ? (
            <div className="flex h-fit min-w-[272px] max-w-[320px] shrink-0 flex-col gap-2 rounded-xl border border-dashed border-neutral-300 bg-neutral-50/70 p-3 dark:border-neutral-700 dark:bg-neutral-900/40">
              <Input
                autoFocus
                value={newColumnTitle}
                onChange={event => setNewColumnTitle(event.target.value)}
                onBlur={handleAddColumn}
                onKeyDown={event => {
                  if (event.key === "Enter") void handleAddColumn();
                  else if (event.key === "Escape") {
                    setAddingColumn(false);
                    setNewColumnTitle("");
                  }
                }}
                placeholder={t("kanban:addColumn.placeholder", { defaultValue: "列标题" })}
                className="h-8"
              />
            </div>
          ) : null}

          <DragOverlay>{activeCard ? <KanbanCard card={activeCard} onOpen={() => undefined} /> : null}</DragOverlay>
        </DndContext>
      </div>

      {editor ? (
        <KanbanCardEditor
          card={editor.card}
          defaultColumnId={editor.columnId}
          projects={projects}
          currentProjectPath={projectKey ?? undefined}
          onSave={handleSaveEditor}
          onArchive={cardId => actions.archiveCard(cardId)}
          onRestore={cardId => actions.restoreCard(cardId)}
          onPurge={cardId => actions.purgeCard(cardId)}
          onDuplicate={cardId => actions.duplicateCard(cardId)}
          onMoveToWorkspace={(cardId, toProjectKey) => actions.moveToProject(cardId, toProjectKey)}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}
