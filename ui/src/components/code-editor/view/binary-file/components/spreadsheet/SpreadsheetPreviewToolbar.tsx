import { useTranslation } from "react-i18next";
import type { CodeEditorFile } from "../../../../types/types";
import { api } from "../../../../../../utils/api";

export default function SpreadsheetPreviewToolbar({
  zoom,
  projectName,
  file,
  isFullscreen,
  refreshing,
  onZoomChange,
  onRefresh,
  onToggleFullscreen,
}: {
  zoom: number;
  projectName?: string;
  file: CodeEditorFile;
  isFullscreen: boolean;
  refreshing: boolean;
  onZoomChange: (zoom: number) => void;
  onRefresh: () => void;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation("codeEditor");
  const iconButtonClass =
    "flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800";

  return (
    <div className="flex h-11 shrink-0 items-center justify-end gap-3 border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(0.25, zoom - 0.1))}
          className={iconButtonClass}
          title={t("pdfToolbar.zoomOut")}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" strokeWidth="1.75" />
            <path d="M8 11h6m2.5 5.5L21 21" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        <span className="min-w-[52px] text-center text-[12px] text-neutral-600 tabular-nums dark:text-neutral-300">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => onZoomChange(Math.min(2, zoom + 0.1))}
          className={iconButtonClass}
          title={t("pdfToolbar.zoomIn")}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" strokeWidth="1.75" />
            <path d="M8 11h6m-3-3v6m5.5 2.5L21 21" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        <span className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-800" />
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className={iconButtonClass}
          title={t("pdfToolbar.refresh")}
        >
          <svg
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M20 7v5h-5M4 17v-5h5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
            <path d="M6.1 8.5A7 7 0 0118.5 7M17.9 15.5A7 7 0 015.5 17" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        {onToggleFullscreen && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={iconButtonClass}
            title={isFullscreen ? t("actions.exitFullscreen") : t("actions.fullscreen")}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d={
                  isFullscreen
                    ? "M9 9H4V4m5 5L3.5 3.5M15 9h5V4m-5 5l5.5-5.5M9 15H4v5m5-5l-5.5 5.5M15 15h5v5m-5-5l5.5 5.5"
                    : "M4 9V4h5M4 4l5.5 5.5M20 9V4h-5m5 0l-5.5 5.5M4 15v5h5m-5 0l5.5-5.5M20 15v5h-5m5 0l-5.5-5.5"
                }
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
              />
            </svg>
          </button>
        )}
        {projectName && (
          <a
            href={api.fileDownloadUrl(projectName, file.path)}
            download={file.name}
            className={iconButtonClass}
            title={t("actions.download")}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M12 3v12m0 0l-4-4m4 4l4-4M5 20h14"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
              />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}
