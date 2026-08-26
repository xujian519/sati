import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { Calendar, Link2 } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { LABEL_META, LABEL_OPTIONS, PRIORITY_META } from "../constants/constants";
import type { BoardCard } from "../types/types";

type KanbanCardProps = {
  card: BoardCard;
  onOpen: (card: BoardCard) => void;
  onOpenSource?: (card: BoardCard) => void;
};

export function KanbanCard({ card, onOpen, onOpenSource }: KanbanCardProps) {
  const { t } = useTranslation();
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", columnId: card.columnId },
  });

  const priorityMeta = PRIORITY_META[card.priority];
  const labelMeta = LABEL_META[card.label];
  const labelOption = LABEL_OPTIONS.find(option => option.value === card.label);
  const labelText = labelOption ? t(labelOption.labelKey) : card.label;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card)}
      className={cn(
        "group cursor-grab rounded-lg border border-neutral-200 bg-white p-3 text-left shadow-sm transition-shadow select-none hover:shadow-md active:cursor-grabbing dark:border-neutral-800 dark:bg-neutral-900",
        isDragging && "opacity-60 shadow-lg ring-2 ring-brand-500/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: card.color }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 font-medium text-neutral-800 dark:text-neutral-100">{card.title}</p>
          {card.note ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-neutral-500 dark:text-neutral-400">{card.note}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {priorityMeta ? (
          <span className="inline-flex items-center gap-1 text-[11px]">
            <span className={cn("h-1.5 w-1.5 rounded-full", priorityMeta.dotClass)} aria-hidden="true" />
            <span className={priorityMeta.colorClass}>{t(priorityMeta.labelKey)}</span>
          </span>
        ) : null}
        {card.label && labelMeta ? (
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] leading-4", labelMeta.className)}>{labelText}</span>
        ) : null}
        {card.dueDate ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500">
            <Calendar className="h-3 w-3" strokeWidth={1.75} />
            {card.dueDate}
          </span>
        ) : null}
        {card.source?.sessionKey && onOpenSource ? (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation();
              onOpenSource(card);
            }}
            className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/30"
            aria-label={t("kanban:card.openSource", { defaultValue: "打开源会话" })}
            title={t("kanban:card.openSource", { defaultValue: "打开源会话" })}
          >
            <Link2 className="h-3 w-3" strokeWidth={1.75} />
            {t("kanban:card.source", { defaultValue: "源会话" })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
