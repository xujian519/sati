/**
 * 底部操作栏：批量模式的「导入 N 个 / 完成」与单技能模式的「导入技能」。
 * JSX 与 className 从原组件逐字搬出，仅把闭包变量换为 props。
 */
import { CheckCircle2, FolderInput, Loader2 } from "lucide-react";
import type { Translator } from "./types";

export function ImportFooter({
  batchMode,
  batchDone,
  selectedCount,
  batchImporting,
  onBatchSubmit,
  onBatchDone,
  canSubmit,
  importing,
  onSubmit,
  t,
}: {
  batchMode: boolean;
  batchDone: boolean;
  selectedCount: number;
  batchImporting: boolean;
  onBatchSubmit: () => void;
  onBatchDone: () => void;
  canSubmit: boolean;
  importing: boolean;
  onSubmit: () => void;
  t: Translator;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
      {batchMode ? (
        batchDone ? (
          <button
            type="button"
            onClick={onBatchDone}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t("skillsTab.batchDone", { defaultValue: "Done" })}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onBatchSubmit}
            disabled={selectedCount === 0 || batchImporting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {batchImporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <FolderInput className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            <span>
              {batchImporting
                ? t("skillsTab.importing", { defaultValue: "Importing…" })
                : t("skillsTab.importNSkills", { defaultValue: "Import {{count}} skills", count: selectedCount })}
            </span>
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {importing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <FolderInput className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          <span>
            {importing
              ? t("skillsTab.importing", { defaultValue: "Importing…" })
              : t("skillsTab.importAction", { defaultValue: "Import skill" })}
          </span>
        </button>
      )}
    </div>
  );
}
