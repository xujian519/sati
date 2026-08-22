import { ArrowLeft, Crosshair, Map, Maximize, Minus, Plus, RotateCcw } from "lucide-react";

export type MapToolbarProps = {
  scale: number;
  onReset: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onLocateSession?: () => void;
  onBackToChat?: () => void;
};

export function MapToolbar({
  scale,
  onReset,
  onZoomIn,
  onZoomOut,
  onFit,
  onLocateSession,
  onBackToChat,
}: MapToolbarProps) {
  const buttonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-600 shadow-sm transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

  const textButtonClass =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-600 shadow-sm transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

  return (
    <div className="absolute top-4 left-4 right-4 z-10 flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-neutral-200 bg-white/90 p-1.5 shadow-sm backdrop-blur-sm dark:border-neutral-700 dark:bg-neutral-900/90">
      <div className="flex flex-wrap items-center gap-1.5">
        <Map className="mx-1 h-4 w-4 text-neutral-500" />
        <button type="button" className={buttonClass} onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[3ch] px-1 text-center text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
          {Math.round(scale * 100)}%
        </span>
        <button type="button" className={buttonClass} onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />
        <button type="button" className={buttonClass} onClick={onFit} title="Fit to view" aria-label="Fit to view">
          <Maximize className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={buttonClass} onClick={onReset} title="Reset view" aria-label="Reset view">
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        {onLocateSession ? (
          <button
            type="button"
            className={buttonClass}
            onClick={onLocateSession}
            title="Locate current session"
            aria-label="Locate current session"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {onBackToChat ? (
        <button
          type="button"
          data-map-back-to-chat
          className={textButtonClass}
          onClick={onBackToChat}
          title="Back to chat"
          aria-label="Back to chat"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Back to chat</span>
        </button>
      ) : null}
    </div>
  );
}
