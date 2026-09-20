import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import type { DocumentSelectionSource } from "../../../../types/documentSelection";
import type { ContentReferenceSelectionMode } from "../../../../types/contentReference";
import type { PdfNavigationMode } from "../../utils/documentPreview";
import type { PdfOutlineItem } from "../../utils/pdfOutline";
import { MAX_SCALE, MIN_SCALE, type PageSize, type Rotation, type ZoomMode } from "../../utils/pdfViewport";
import { usePdfSearch } from "../../hooks/usePdfSearch";
import type { PdfSearchMatch } from "../../utils/pdfSearch";
import PdfNavigationSidebar from "../pdf/components/PdfNavigationSidebar";
import PdfPage from "../pdf/components/PdfPage";
import PdfToolbar from "../pdf/components/PdfToolbar";
import { usePdfScrollTracking } from "../pdf/hooks/use-pdf-scroll-tracking";
import { usePdfSelectionReference } from "../pdf/hooks/use-pdf-selection-reference";
import { usePdfToolbarController } from "../pdf/hooks/use-pdf-toolbar-controller";
import { usePdfViewport } from "../pdf/hooks/use-pdf-viewport";
import type { NavigationView, PdfSelectionAction, ViewerSize } from "../pdf/pdf-types";
import * as pdfjs from "./pdfjs";
import RegionSelectionOverlay from "./RegionSelectionOverlay";
import { floatingSelectionSingleActionClassName } from "./floatingSelectionAction";

type PdfDocumentPreviewProps = {
  blob?: Blob;
  url?: string;
  projectName?: string;
  fileName: string;
  filePath: string;
  source: DocumentSelectionSource;
  /** Distinguishes multiple PDF views backed by the same source file. */
  viewKey?: string;
  loadingOverlay?: string | null;
  navigationMode?: PdfNavigationMode;
  showPageControls?: boolean;
  onRefresh?: (() => void) | null;
  refreshDisabled?: boolean;
  downloadUrl?: string | null;
  downloadName?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | null;
};

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function PdfDocumentPreview({
  blob,
  url,
  projectName,
  fileName,
  filePath,
  source,
  viewKey = "",
  loadingOverlay = null,
  navigationMode = "none",
  showPageControls = true,
  onRefresh = null,
  refreshDisabled = false,
  downloadUrl = null,
  downloadName,
  isFullscreen = false,
  onToggleFullscreen = null,
}: PdfDocumentPreviewProps) {
  const { t } = useTranslation("codeEditor");
  const inputId = useId();
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pageTextRef = useRef(new Map<number, string>());
  const pageTextItemsRef = useRef(new Map<number, string[]>());
  const visiblePageNumbersRef = useRef(new Set<number>());
  const forcedRenderPageNumbersRef = useRef(new Set<number>());
  const [pdfDocument, setPdfDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [firstPageSize, setFirstPageSize] = useState<PageSize | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewerSize, setViewerSize] = useState<ViewerSize>({ width: 0, height: 0 });
  const [selectionAction, setSelectionAction] = useState<PdfSelectionAction | null>(null);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const [forcedRenderPageNumbers, setForcedRenderPageNumbers] = useState<Set<number>>(() => new Set());
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fitPage");
  const [customScale, setCustomScale] = useState(1);
  const [zoomInput, setZoomInput] = useState("100%");
  const [zoomInputFocused, setZoomInputFocused] = useState(false);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageInputFocused, setPageInputFocused] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(navigationMode !== "none");
  const [navigationView, setNavigationView] = useState<NavigationView>("thumbnails");
  const [outlineItems, setOutlineItems] = useState<PdfOutlineItem[]>([]);
  const navigationRef = useRef<HTMLDivElement | null>(null);

  /** 把某页纳入强制渲染集合——命中搜索或大纲跳页时，目标页可能还没渲染。 */
  const forceRenderPage = useCallback((pageNumber: number) => {
    forcedRenderPageNumbersRef.current.add(pageNumber);
    setForcedRenderPageNumbers(new Set(forcedRenderPageNumbersRef.current));
  }, []);

  const jumpToPage = useCallback((pageNumber: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const target = viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`);
    if (target) {
      const viewerRect = viewer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      viewer.scrollTo({
        top: viewer.scrollTop + targetRect.top - viewerRect.top - 12,
      });
    }
    setCurrentPage(pageNumber);
  }, []);

  // 搜索状态机整体外置（#159 N07）；下面加载 effect 的复位走它的 `reset`。
  const {
    isOpen: searchOpen,
    query: searchQuery,
    results: searchResults,
    resultIndex: searchResultIndex,
    status: searchStatus,
    open: openSearch,
    close: closeSearch,
    updateQuery: updateSearchQuery,
    run: runSearch,
    goTo: goToSearchResult,
    reset: resetSearch,
  } = usePdfSearch({
    pdfDocument,
    pageTextRef,
    pageTextItemsRef,
    jumpToPage,
    forceRenderPage,
  });
  const { viewStateRef, pendingRestoreRef, activeScale, zoomPercent } = usePdfViewport({
    file: { blob, url, source, projectName, filePath, viewKey },
    surface: { viewerRef, viewerSize, setViewerSize },
    doc: { firstPageSize, setFirstPageSize, setPdfDocument, setErrorMessage },
    view: { currentPage, setCurrentPage, zoomMode, setZoomMode },
    scale: { customScale, setCustomScale, rotation, setRotation },
    inputs: { zoomInputFocused, setZoomInput, pageInputFocused, setPageInput },
    reset: { resetSearch, setSelectionAction, setForcedRenderPageNumbers },
    refs: { pageTextRef, pageTextItemsRef, visiblePageNumbersRef, forcedRenderPageNumbersRef },
    navigation: { setNavigationOpen, setNavigationView, setOutlineItems },
    navigationMode,
  });

  const {
    cancelScheduledSelectionAction,
    scheduleSelectionAction,
    handleAddReference,
    referenceCapabilities,
    handleReferenceMode,
    handleRegionCommit,
  } = usePdfSelectionReference({
    viewer: { viewerRef, pageTextRef, pdfDocument, firstPageSize, currentPage },
    selection: { selectionAction, setSelectionAction, setReferenceMode },
    source: { blob, fileName, filePath, projectName, source },
  });

  const { handlePageVisibilityChange } = usePdfScrollTracking({
    surface: { viewerRef, viewStateRef, pdfDocument, pendingRestoreRef },
    view: { firstPageSize, activeScale, rotation, viewerSize },
    pages: { visiblePageNumbersRef, forcedRenderPageNumbersRef, setForcedRenderPageNumbers },
    pageNavigation: { setCurrentPage, setPageInput },
    selection: { setSelectionAction, cancelScheduledSelectionAction, scheduleSelectionAction },
  });

  const handlePageText = useCallback((pageNumber: number, text: string, textItems: string[]) => {
    pageTextRef.current.set(pageNumber, text);
    pageTextItemsRef.current.set(pageNumber, textItems);
  }, []);
  const searchMatchesByPage = useMemo(() => {
    const matchesByPage = new Map<number, PdfSearchMatch[]>();
    searchResults.forEach(match => {
      const pageMatches = matchesByPage.get(match.pageNumber) || [];
      pageMatches.push(match);
      matchesByPage.set(match.pageNumber, pageMatches);
    });
    return matchesByPage;
  }, [searchResults]);
  const selectedSearchMatchId = searchResultIndex >= 0 ? searchResults[searchResultIndex]?.id || null : null;
  const totalPages = pdfDocument?.numPages || 0;
  const canZoomOut = activeScale > MIN_SCALE;
  const canZoomIn = activeScale < MAX_SCALE;
  const readyDocument = pdfDocument && firstPageSize ? { pdfDocument, firstPageSize } : null;
  const isLoaded = Boolean(readyDocument);
  const zoomInputId = `${inputId}-pdf-zoom`;
  const pageInputId = `${inputId}-pdf-page`;
  const searchInputId = `${inputId}-pdf-search`;
  const navigationLabel = navigationMode === "slides" ? t("pdfToolbar.slides") : t("pdfToolbar.pages");
  const hasOutline = navigationMode === "pages" && outlineItems.length > 0;
  const currentLocationLabel = navigationMode === "slides" ? t("pdfToolbar.slideNumber") : t("pdfToolbar.pageNumber");
  const goToLocationLabel = navigationMode === "slides" ? t("pdfToolbar.goToSlide") : t("pdfToolbar.goToPage");
  const locationOfLabel =
    navigationMode === "slides"
      ? t("pdfToolbar.slideOf", { total: totalPages || "-" })
      : t("pdfToolbar.pageOf", { total: totalPages || "-" });

  const toolbar = usePdfToolbarController({
    stats: { isLoaded, activeScale, canZoomIn, canZoomOut, zoomPercent, currentPage },
    document: { pdfDocument, jumpToPage, source, showPageControls },
    view: { navigationMode, navigationOpen, setNavigationOpen, zoomMode, setZoomMode },
    zoom: { zoomInput, setZoomInput, setZoomInputFocused, setCustomScale },
    page: { rotation, setRotation, pageInput, setPageInput, setPageInputFocused },
    search: { searchOpen, closeSearch, openSearch, searchQuery, updateSearchQuery, runSearch },
    searchState: { searchStatus, searchResults, searchResultIndex, goToSearchResult },
    reference: { referenceCapabilities, referenceMode, handleReferenceMode, setReferenceMode },
    labels: { currentLocationLabel, goToLocationLabel, locationOfLabel, zoomInputId, pageInputId, searchInputId },
    actions: { onRefresh, refreshDisabled, onToggleFullscreen, isFullscreen, downloadUrl, downloadName },
  });

  if (errorMessage) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white p-6 text-center text-[13px] text-red-500 dark:bg-neutral-950">
        {errorMessage}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      <PdfToolbar controller={toolbar} />
      <div className="flex min-h-0 flex-1">
        {navigationMode !== "none" && navigationOpen ? (
          <PdfNavigationSidebar
            navigationMode={navigationMode}
            navigationLabel={navigationLabel}
            hasOutline={hasOutline}
            navigationView={navigationView}
            setNavigationView={setNavigationView}
            outlineItems={outlineItems}
            currentPage={currentPage}
            jumpToPage={jumpToPage}
            totalPages={totalPages}
            readyDocument={readyDocument}
            rotation={rotation}
            filePath={filePath}
            navigationRef={navigationRef}
          />
        ) : null}
        <div
          ref={viewerRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-900"
        >
          {!readyDocument ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
            </div>
          ) : (
            <div className="px-4 py-2">
              {Array.from({ length: readyDocument.pdfDocument.numPages }, (_, index) => (
                <PdfPage
                  key={`${filePath}-${index + 1}`}
                  pdfDocument={readyDocument.pdfDocument}
                  pageNumber={index + 1}
                  scale={activeScale}
                  rotation={rotation}
                  basePageSize={readyDocument.firstPageSize}
                  viewerRootRef={viewerRef}
                  forceRender={forcedRenderPageNumbers.has(index + 1)}
                  searchMatches={searchMatchesByPage.get(index + 1) || []}
                  selectedSearchMatchId={selectedSearchMatchId}
                  onPageText={handlePageText}
                  onPageVisibilityChange={handlePageVisibilityChange}
                />
              ))}
            </div>
          )}

          {loadingOverlay ? (
            <div className="absolute top-3 left-3 z-10 rounded-md border border-neutral-200 bg-white/95 px-3 py-1.5 text-[12px] text-neutral-600 shadow-xs backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95 dark:text-neutral-300">
              {loadingOverlay}
            </div>
          ) : null}

          {selectionAction ? (
            <button
              type="button"
              onMouseDown={event => event.preventDefault()}
              onClick={handleAddReference}
              className={`absolute z-20 ${floatingSelectionSingleActionClassName}`}
              style={{ top: selectionAction.top, left: selectionAction.left }}
            >
              {t("selection.chatInSati")}
            </button>
          ) : null}
          <RegionSelectionOverlay
            active={referenceMode === "region"}
            hostRef={viewerRef}
            resolveTarget={element => {
              const page = element?.closest<HTMLElement>("[data-pdf-page-number]");
              if (!page || !viewerRef.current?.contains(page)) return null;
              const pageNumber = Number(page.dataset.pdfPageNumber || currentPage);
              return {
                element: page,
                surface: "page",
                pageNumber,
                nearbyText: pageTextRef.current.get(pageNumber),
              };
            }}
            onCommit={handleRegionCommit}
            onCancel={() => setReferenceMode(null)}
          />
        </div>
      </div>
    </div>
  );
}
