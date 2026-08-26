import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { Check, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import type { BoardCard, BoardColumn } from "../types/types";
import { KanbanCard } from "./KanbanCard";

type KanbanColumnProps = {
  column: BoardColumn;
  cards: BoardCard[];
  onOpenCard: (card: BoardCard) => void;
  onAddCard: (columnId: string) => void;
  onRenameColumn: (columnId: string, title: string) => void;
  onDeleteColumn: (columnId: string) => void;
};

export function KanbanColumn({
  column,
  cards,
  onOpenCard,
  onAddCard,
  onRenameColumn,
  onDeleteColumn,
}: KanbanColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: "column", columnId: column.id } });
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(column.title);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (menuOpen) {
      const handlePointerDown = (event: PointerEvent) => {
        if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
      };
      document.addEventListener("pointerdown", handlePointerDown);
      return () => document.removeEventListener("pointerdown", handlePointerDown);
    }
    return undefined;
  }, [menuOpen]);

  useEffect(() => {
    if (renaming) {
      setTitleDraft(column.title);
      renameRef.current?.focus();
      renameRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);

  const commitRename = () => {
    const next = titleDraft.trim();
    setRenaming(false);
    if (next && next !== column.title) onRenameColumn(column.id, next);
  };

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex h-full min-w-[272px] max-w-[320px] flex-col rounded-xl border border-neutral-200 bg-neutral-50/70 dark:border-neutral-800 dark:bg-neutral-900/40",
        isOver && "ring-2 ring-brand-500/50",
      )}
    >
      {/* 列头 */}
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: column.color }}
        />
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              ref={renameRef}
              value={titleDraft}
              onChange={event => setTitleDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={event => {
                if (event.key === "Enter") commitRename();
                else if (event.key === "Escape") setRenaming(false);
              }}
              className="h-7 px-2 text-[13px]"
              aria-label={t("kanban:renameColumn.title", { defaultValue: "重命名列" })}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={commitRename}
              aria-label={t("save", { defaultValue: "保存" })}
            >
              <Check className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              {column.title}
            </h3>
            <span className="shrink-0 rounded bg-neutral-200/70 px-1.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {cards.length}
            </span>
            <div ref={menuRef} className="relative shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7 text-neutral-400",
                  menuOpen && "bg-neutral-200/70 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-200",
                )}
                onClick={() => setMenuOpen(open => !open)}
                aria-label={t("kanban:columnMenu.label", { defaultValue: "列操作" })}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute top-9 right-0 z-30 w-36 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setRenaming(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    <Pencil className="h-3.5 w-3.5" /> {t("kanban:renameColumn.title", { defaultValue: "重命名列" })}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onDeleteColumn(column.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {t("kanban:deleteColumn.title", { defaultValue: "删除列" })}
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </header>

      {/* 卡片流 */}
      <SortableContext items={cards.map(card => card.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {cards.length === 0 ? (
            <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-6 text-center text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
              {t("kanban:emptyColumn", { defaultValue: "暂无可拖拽卡片" })}
            </p>
          ) : (
            cards.map(card => <KanbanCard key={card.id} card={card} onOpen={onOpenCard} />)
          )}
        </div>
      </SortableContext>

      <footer className="px-2 pb-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          onClick={() => onAddCard(column.id)}
        >
          <Plus className="h-4 w-4" /> {t("kanban:addCard.title", { defaultValue: "添加卡片" })}
        </Button>
      </footer>
    </section>
  );
}
