import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2, X } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { COLOR_SWATCHES, LABEL_OPTIONS, PRIORITY_ORDER, PRIORITY_META } from "../constants/constants";
import type { BoardCard, BoardPriority } from "../types/types";
import type { Project } from "../../../types/app";
import type { KanbanMutationResult } from "../hooks/useBoardState";
import { KanbanWorkspacePicker } from "./KanbanWorkspacePicker";

export type KanbanCardDraft = {
  columnId: string;
  title: string;
  note: string;
  label: string;
  priority: BoardPriority;
  color: string;
  dueDate?: string;
};

type KanbanCardEditorProps = {
  /** 待编辑卡片；null 表示新建。 */
  card: BoardCard | null;
  /** 新建时的默认列。 */
  defaultColumnId: string;
  projects: Project[];
  currentProjectPath?: string;
  /** 保存（新建或更新）。 */
  onSave: (draft: KanbanCardDraft) => Promise<KanbanMutationResult>;
  onArchive?: (cardId: string) => Promise<KanbanMutationResult>;
  onRestore?: (cardId: string) => Promise<KanbanMutationResult>;
  onPurge?: (cardId: string) => Promise<KanbanMutationResult>;
  onDuplicate?: (cardId: string) => Promise<KanbanMutationResult>;
  onMoveToWorkspace?: (cardId: string, toProjectKey: string) => Promise<KanbanMutationResult>;
  onClose: () => void;
};

export function KanbanCardEditor({
  card,
  defaultColumnId,
  projects,
  currentProjectPath,
  onSave,
  onArchive,
  onRestore,
  onPurge,
  onDuplicate,
  onMoveToWorkspace,
  onClose,
}: KanbanCardEditorProps) {
  const { t } = useTranslation();
  const isCreate = card === null;
  const [title, setTitle] = useState(card?.title ?? "");
  const [note, setNote] = useState(card?.note ?? "");
  const [label, setLabel] = useState(card?.label ?? "");
  const [priority, setPriority] = useState<BoardPriority>(card?.priority ?? "medium");
  const [color, setColor] = useState(card?.color ?? "#0ea5e9");
  const [dueDate, setDueDate] = useState(card?.dueDate ?? "");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isArchived = card?.archived === true;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setActionError(t("kanban:editor.titleRequired", { defaultValue: "标题不能为空" }));
      return;
    }
    setSaving(true);
    setActionError(null);
    const result = await onSave({
      columnId: card?.columnId ?? defaultColumnId,
      title: trimmedTitle,
      note,
      label,
      priority,
      color,
      dueDate: dueDate || undefined,
    });
    setSaving(false);
    if (result.ok) onClose();
    else setActionError(result.error ?? t("kanban:editor.saveFailed", { defaultValue: "保存失败" }));
  };

  const runAction = async (action: (cardId: string) => Promise<KanbanMutationResult>) => {
    if (!card) return;
    setActionError(null);
    const result = await action(card.id);
    if (result.ok) onClose();
    else setActionError(result.error ?? t("kanban:editor.actionFailed", { defaultValue: "操作失败" }));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh]"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {isCreate
              ? t("kanban:editor.createTitle", { defaultValue: "新建卡片" })
              : t("kanban:editor.editTitle", { defaultValue: "编辑卡片" })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label={t("close", { defaultValue: "关闭" })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("kanban:editor.title", { defaultValue: "标题" })}
            </label>
            <Input
              value={title}
              onChange={event => setTitle(event.target.value)}
              autoFocus
              placeholder={t("kanban:editor.titlePlaceholder", { defaultValue: "卡片标题" })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("kanban:editor.note", { defaultValue: "备注" })}
            </label>
            <Textarea
              value={note}
              onChange={event => setNote(event.target.value)}
              rows={3}
              placeholder={t("kanban:editor.notePlaceholder", { defaultValue: "背景 / 验收标准" })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("kanban:editor.label", { defaultValue: "标签" })}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {LABEL_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setLabel(current => (current === option.value ? "" : option.value))}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    label === option.value
                      ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200"
                      : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400",
                  )}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("kanban:editor.priority", { defaultValue: "优先级" })}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PRIORITY_ORDER.map(value => {
                const meta = PRIORITY_META[value];
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPriority(value)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      priority === value
                        ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} aria-hidden="true" />
                    {t(meta.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("kanban:editor.color", { defaultValue: "颜色" })}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_SWATCHES.map(swatch => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  className={cn(
                    "h-7 w-7 rounded-full transition-transform hover:scale-110",
                    color === swatch && "ring-2 ring-brand-500 ring-offset-2 dark:ring-offset-neutral-900",
                  )}
                  style={{ backgroundColor: swatch }}
                  aria-label={swatch}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("kanban:editor.dueDate", { defaultValue: "截止日期" })}
            </label>
            <Input
              type="date"
              value={dueDate}
              onChange={event => setDueDate(event.target.value)}
              className="max-w-[220px]"
            />
          </div>
        </div>

        {actionError ? <p className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{actionError}</p> : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("kanban:editor.saving", { defaultValue: "保存中…" }) : t("save", { defaultValue: "保存" })}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t("cancel", { defaultValue: "取消" })}
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            {card && !isArchived ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => runAction(onDuplicate ?? (() => Promise.resolve({ ok: true })))}
              >
                <Copy className="h-3.5 w-3.5" /> {t("kanban:editor.duplicate", { defaultValue: "复制" })}
              </Button>
            ) : null}
            {card && !isArchived ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 dark:text-red-400"
                onClick={() => runAction(onArchive ?? (() => Promise.resolve({ ok: true })))}
              >
                <Trash2 className="h-3.5 w-3.5" /> {t("kanban:editor.archive", { defaultValue: "删除" })}
              </Button>
            ) : null}
            {card && isArchived ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => runAction(onRestore ?? (() => Promise.resolve({ ok: true })))}
              >
                {t("kanban:editor.restore", { defaultValue: "恢复" })}
              </Button>
            ) : null}
            {card && isArchived ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 dark:text-red-400"
                onClick={() => runAction(onPurge ?? (() => Promise.resolve({ ok: true })))}
              >
                {t("kanban:editor.purge", { defaultValue: "彻底删除" })}
              </Button>
            ) : null}
            {card && !isArchived && onMoveToWorkspace ? (
              <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>
                {t("kanban:editor.move", { defaultValue: "移动" })}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {pickerOpen && card ? (
        <KanbanWorkspacePicker
          projects={projects}
          excludePath={currentProjectPath}
          onSelect={async toProjectKey => {
            setPickerOpen(false);
            await runAction(cardId =>
              onMoveToWorkspace ? onMoveToWorkspace(cardId, toProjectKey) : Promise.resolve({ ok: true }),
            );
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
