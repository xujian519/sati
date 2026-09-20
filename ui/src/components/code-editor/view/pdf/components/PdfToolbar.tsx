import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize,
  Maximize2,
  Minimize,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  StretchHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ZOOM_STEP, type Rotation } from "../../../utils/pdfViewport";
import ContentReferenceMenu from "../../subcomponents/ContentReferenceMenu";
import type { PdfToolbarController } from "../hooks/use-pdf-toolbar-controller";
import { ToolbarButton, ToolbarLink, ToolbarSeparator } from "./ToolbarPrimitives";
import { renderToolbarIcon } from "./pdf-toolbar-icon";

/**
 * PDF 工具栏。控制器对象（`usePdfToolbarController`）一次性喂入全部工具条输入，
 * 组件里只做解构 + 渲染（#159 N07）。
 */
export default function PdfToolbar({ controller }: { controller: PdfToolbarController }) {
  const {
    t,
    navigationMode,
    navigationOpen,
    setNavigationOpen,
    isLoaded,
    canZoomOut,
    setCustomZoomFromScale,
    activeScale,
    zoomInputId,
    zoomInput,
    setZoomInputFocused,
    setZoomInput,
    commitZoomInput,
    zoomPercent,
    canZoomIn,
    zoomMode,
    setZoomMode,
    source,
    setRotation,
    showPageControls,
    pageInputId,
    pageInput,
    setPageInputFocused,
    setPageInput,
    commitPageInput,
    currentLocationLabel,
    goToLocationLabel,
    locationOfLabel,
    currentPage,
    searchOpen,
    closeSearch,
    openSearch,
    searchInputId,
    searchQuery,
    updateSearchQuery,
    runSearch,
    searchStatus,
    searchResults,
    searchResultIndex,
    goToSearchResult,
    referenceCapabilities,
    referenceMode,
    handleReferenceMode,
    setReferenceMode,
    onRefresh,
    refreshDisabled,
    onToggleFullscreen,
    isFullscreen,
    downloadUrl,
    downloadName,
  } = controller;
  return (
    <div className="scrollbar-hide flex min-h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-neutral-200 bg-white px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-950">
      {navigationMode !== "none" ? (
        <>
          <ToolbarButton
            title={navigationOpen ? t("pdfToolbar.hideNavigation") : t("pdfToolbar.showNavigation")}
            active={navigationOpen}
            disabled={!isLoaded}
            onClick={() => setNavigationOpen(open => !open)}
          >
            {renderToolbarIcon(PanelLeft)}
          </ToolbarButton>
          <ToolbarSeparator />
        </>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        <ToolbarButton
          title={t("pdfToolbar.zoomOut")}
          disabled={!isLoaded || !canZoomOut}
          onClick={() => setCustomZoomFromScale(activeScale - ZOOM_STEP)}
        >
          {renderToolbarIcon(ZoomOut)}
        </ToolbarButton>
        <label className="sr-only" htmlFor={zoomInputId}>
          {t("pdfToolbar.zoomPercent")}
        </label>
        <input
          id={zoomInputId}
          value={zoomInput}
          disabled={!isLoaded}
          inputMode="numeric"
          aria-label={t("pdfToolbar.zoomPercent")}
          onFocus={event => {
            setZoomInputFocused(true);
            event.currentTarget.select();
          }}
          onChange={event => setZoomInput(event.target.value)}
          onBlur={() => {
            commitZoomInput();
            setZoomInputFocused(false);
          }}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setZoomInput(`${zoomPercent}%`);
              event.currentTarget.blur();
            }
          }}
          className="h-8 w-16 rounded-md border border-neutral-200 bg-white px-2 text-center text-[12px] text-neutral-800 outline-hidden transition focus:border-neutral-400 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-neutral-600"
        />
        <ToolbarButton
          title={t("pdfToolbar.zoomIn")}
          disabled={!isLoaded || !canZoomIn}
          onClick={() => setCustomZoomFromScale(activeScale + ZOOM_STEP)}
        >
          {renderToolbarIcon(ZoomIn)}
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton
          title={t("pdfToolbar.fitWidth")}
          active={zoomMode === "fitWidth"}
          disabled={!isLoaded}
          onClick={() => setZoomMode("fitWidth")}
        >
          {renderToolbarIcon(StretchHorizontal)}
        </ToolbarButton>
        <ToolbarButton
          title={t("pdfToolbar.fitPage")}
          active={zoomMode === "fitPage"}
          disabled={!isLoaded}
          onClick={() => setZoomMode("fitPage")}
        >
          {renderToolbarIcon(Maximize2)}
        </ToolbarButton>
        {source === "pdf" ? (
          <>
            <ToolbarButton
              title={t("pdfToolbar.rotateCounterClockwise")}
              disabled={!isLoaded}
              onClick={() => setRotation(value => ((value + 270) % 360) as Rotation)}
            >
              {renderToolbarIcon(RotateCcw)}
            </ToolbarButton>
            <ToolbarButton
              title={t("pdfToolbar.rotateClockwise")}
              disabled={!isLoaded}
              onClick={() => setRotation(value => ((value + 90) % 360) as Rotation)}
            >
              {renderToolbarIcon(RotateCw)}
            </ToolbarButton>
          </>
        ) : null}
      </div>
      {showPageControls ? (
        <>
          <ToolbarSeparator />
          <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
            <label className="sr-only" htmlFor={pageInputId}>
              {currentLocationLabel}
            </label>
            <input
              id={pageInputId}
              value={pageInput}
              disabled={!isLoaded}
              inputMode="numeric"
              aria-label={goToLocationLabel}
              onFocus={event => {
                setPageInputFocused(true);
                event.currentTarget.select();
              }}
              onChange={event => setPageInput(event.target.value)}
              onBlur={() => {
                commitPageInput();
                setPageInputFocused(false);
              }}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setPageInput(String(currentPage));
                  event.currentTarget.blur();
                }
              }}
              className="h-8 w-12 rounded-md border border-neutral-200 bg-white px-1.5 text-center text-[12px] text-neutral-800 outline-hidden transition focus:border-neutral-400 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-neutral-600"
            />
            <span className="whitespace-nowrap">{locationOfLabel}</span>
          </div>
        </>
      ) : null}
      <ToolbarSeparator />
      <ToolbarButton
        title={t("pdfToolbar.search")}
        active={searchOpen}
        disabled={!isLoaded}
        onClick={() => {
          if (searchOpen) {
            closeSearch();
          } else {
            openSearch();
            window.requestAnimationFrame(() => {
              document.getElementById(searchInputId)?.focus();
            });
          }
        }}
      >
        {renderToolbarIcon(Search)}
      </ToolbarButton>
      {searchOpen ? (
        <div
          role="search"
          className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-white p-0.5 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <label className="sr-only" htmlFor={searchInputId}>
            {t("pdfToolbar.search")}
          </label>
          <input
            id={searchInputId}
            value={searchQuery}
            placeholder={t("pdfToolbar.searchPlaceholder")}
            onChange={event => {
              // 查询词变更时立刻作废在途搜索——原注释随该逻辑一并移入
              // `usePdfSearch.updateQuery`：否则上一条慢查询会在用户提交新值后回填过期结果。
              updateSearchQuery(event.target.value);
            }}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runSearch();
              } else if (event.key === "Escape") {
                closeSearch();
              }
            }}
            className="h-7 w-40 bg-transparent px-2 text-[12px] text-neutral-800 outline-hidden placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          <span className="min-w-12 text-center text-[11px] whitespace-nowrap text-neutral-500 tabular-nums dark:text-neutral-400">
            {searchStatus}
          </span>
          <ToolbarButton
            title={t("pdfToolbar.previousResult")}
            disabled={searchResults.length === 0}
            onClick={() => goToSearchResult(searchResultIndex - 1)}
          >
            {renderToolbarIcon(ChevronLeft)}
          </ToolbarButton>
          <ToolbarButton
            title={t("pdfToolbar.nextResult")}
            disabled={searchResults.length === 0}
            onClick={() => goToSearchResult(searchResultIndex + 1)}
          >
            {renderToolbarIcon(ChevronRight)}
          </ToolbarButton>
          <ToolbarButton title={t("pdfToolbar.closeSearch")} onClick={closeSearch}>
            {renderToolbarIcon(X)}
          </ToolbarButton>
        </div>
      ) : null}
      <ToolbarSeparator />
      <ContentReferenceMenu
        capabilities={referenceCapabilities}
        activeMode={referenceMode}
        onSelectMode={handleReferenceMode}
        onCancelMode={() => setReferenceMode(null)}
        compact
      />
      {onRefresh || onToggleFullscreen || downloadUrl ? <ToolbarSeparator /> : null}
      {onRefresh ? (
        <ToolbarButton title={t("pdfToolbar.refresh")} disabled={refreshDisabled} onClick={onRefresh}>
          <span className={refreshDisabled ? "animate-spin" : ""}>{renderToolbarIcon(RefreshCw)}</span>
        </ToolbarButton>
      ) : null}
      {onToggleFullscreen ? (
        <ToolbarButton
          title={isFullscreen ? t("actions.exitFullscreen") : t("actions.fullscreen")}
          onClick={onToggleFullscreen}
        >
          {renderToolbarIcon(isFullscreen ? Minimize : Maximize)}
        </ToolbarButton>
      ) : null}
      {downloadUrl ? (
        <ToolbarLink title={t("actions.download")} href={downloadUrl} download={downloadName}>
          {renderToolbarIcon(Download)}
        </ToolbarLink>
      ) : null}
    </div>
  );
}
