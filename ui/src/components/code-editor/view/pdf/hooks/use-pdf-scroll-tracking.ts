import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { clamp, type PageSize, type Rotation } from "../../../utils/pdfViewport";
import * as pdfjs from "../../subcomponents/pdfjs";
import type { PdfSelectionAction, PdfViewState, ViewerSize } from "../pdf-types";

type UsePdfScrollTrackingOptions = {
  surface: {
    viewerRef: RefObject<HTMLDivElement | null>;
    viewStateRef: RefObject<PdfViewState>;
    pdfDocument: pdfjs.PDFDocumentProxy | null;
    pendingRestoreRef: RefObject<PdfViewState | null>;
  };
  view: {
    firstPageSize: PageSize | null;
    activeScale: number;
    rotation: Rotation;
    viewerSize: ViewerSize;
  };
  pages: {
    visiblePageNumbersRef: RefObject<Set<number>>;
    forcedRenderPageNumbersRef: RefObject<Set<number>>;
    setForcedRenderPageNumbers: Dispatch<SetStateAction<Set<number>>>;
  };
  pageNavigation: {
    setCurrentPage: Dispatch<SetStateAction<number>>;
    setPageInput: Dispatch<SetStateAction<string>>;
  };
  selection: {
    setSelectionAction: Dispatch<SetStateAction<PdfSelectionAction | null>>;
    cancelScheduledSelectionAction: () => void;
    scheduleSelectionAction: () => void;
  };
};

/**
 * 滚动跟踪：可见页集合 → 当前页、视口内强制渲染页集合、rAF 节流调度，以及随文件切换的
 * 视口恢复与滚动/选区监听。
 *
 * 从 `view/subcomponents/PdfDocumentPreview.tsx` 抽出（#159 N07）。原先"滚动/选区监听"
 * 那个 effect 同时依赖滚动调度与选区防抖，因此落在本 hook（选区 hook 因此不含 effect）；
 * 这样主组件里这套 effect 的**声明顺序与抽前完全一致**：清理 → 监听 → 重排调度 → 视口恢复。
 */
export function usePdfScrollTracking({ surface, view, pages, pageNavigation, selection }: UsePdfScrollTrackingOptions) {
  const { viewerRef, viewStateRef, pdfDocument, pendingRestoreRef } = surface;
  const { firstPageSize, activeScale, rotation, viewerSize } = view;
  const { visiblePageNumbersRef, forcedRenderPageNumbersRef, setForcedRenderPageNumbers } = pages;
  const { setCurrentPage, setPageInput } = pageNavigation;
  const { setSelectionAction, cancelScheduledSelectionAction, scheduleSelectionAction } = selection;
  const scrollRafRef = useRef<number | null>(null);
  const renderFallbackRafRef = useRef<number | null>(null);

  const updateCurrentPageFromScroll = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const visiblePageNumbers = Array.from(
      new Set([...visiblePageNumbersRef.current, ...forcedRenderPageNumbersRef.current]),
    ).sort((left, right) => left - right);
    const pages =
      visiblePageNumbers.length > 0
        ? visiblePageNumbers
            .map(pageNumber => viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`))
            .filter((page): page is HTMLElement => Boolean(page))
        : Array.from(viewer.querySelectorAll<HTMLElement>("[data-pdf-page-number]"));
    if (pages.length === 0) return;

    const viewerRect = viewer.getBoundingClientRect();
    let bestPage: number | null = null;
    let bestVisibleHeight = 0;
    let bestTopDistance = Number.POSITIVE_INFINITY;

    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const visibleHeight = Math.max(0, Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top));
      const topDistance = Math.abs(rect.top - viewerRect.top);
      const isBetterCandidate =
        visibleHeight > bestVisibleHeight || (visibleHeight === bestVisibleHeight && topDistance < bestTopDistance);
      if (!isBetterCandidate) continue;

      const pageNumber = Number.parseInt(page.dataset.pdfPageNumber || "", 10);
      if (Number.isFinite(pageNumber) && pageNumber > 0) {
        bestPage = pageNumber;
        bestVisibleHeight = visibleHeight;
        bestTopDistance = topDistance;
      }
    }

    if (bestPage !== null) {
      setCurrentPage(previousPage => (previousPage === bestPage ? previousPage : bestPage));
    }
  }, [forcedRenderPageNumbersRef, setCurrentPage, viewerRef, visiblePageNumbersRef]);

  const scheduleCurrentPageUpdate = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateCurrentPageFromScroll();
    });
  }, [updateCurrentPageFromScroll]);

  const updateForcedRenderPages = useCallback(() => {
    const viewer = viewerRef.current;
    const totalPages = pdfDocument?.numPages || 0;
    if (!viewer || totalPages <= 0) {
      forcedRenderPageNumbersRef.current = new Set();
      setForcedRenderPageNumbers(new Set());
      return;
    }

    const viewerRect = viewer.getBoundingClientRect();
    const viewportTop = viewerRect.top - 1200;
    const viewportBottom = viewerRect.bottom + 1200;
    const nextPages = new Set<number>();
    const pages = Array.from(viewer.querySelectorAll<HTMLElement>("[data-pdf-page-number]"));

    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const pageNumber = Number.parseInt(page.dataset.pdfPageNumber || "", 10);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;
      if (rect.bottom >= viewportTop && rect.top <= viewportBottom) {
        nextPages.add(pageNumber);
      }
    }

    if (nextPages.size === 0) {
      nextPages.add(clamp(viewStateRef.current.currentPage, 1, totalPages));
    }

    forcedRenderPageNumbersRef.current = nextPages;
    setForcedRenderPageNumbers(previous => {
      if (previous.size === nextPages.size && Array.from(previous).every(pageNumber => nextPages.has(pageNumber))) {
        return previous;
      }
      return nextPages;
    });
  }, [pdfDocument?.numPages, forcedRenderPageNumbersRef, setForcedRenderPageNumbers, viewStateRef, viewerRef]);

  const scheduleForcedRenderUpdate = useCallback(() => {
    if (renderFallbackRafRef.current !== null) return;
    renderFallbackRafRef.current = window.requestAnimationFrame(() => {
      renderFallbackRafRef.current = null;
      updateForcedRenderPages();
    });
  }, [updateForcedRenderPages]);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (renderFallbackRafRef.current !== null) {
        window.cancelAnimationFrame(renderFallbackRafRef.current);
        renderFallbackRafRef.current = null;
      }
    },
    [],
  );

  const handlePageVisibilityChange = useCallback(
    (pageNumber: number, visible: boolean) => {
      if (visible) {
        visiblePageNumbersRef.current.add(pageNumber);
      } else {
        visiblePageNumbersRef.current.delete(pageNumber);
      }
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
    },
    [scheduleCurrentPageUpdate, scheduleForcedRenderUpdate, visiblePageNumbersRef],
  );

  useEffect(() => {
    const handleSelectionChange = () => setSelectionAction(null);
    const handleScroll = () => {
      const viewer = viewerRef.current;
      if (viewer) {
        viewStateRef.current.scrollTop = viewer.scrollTop;
      }
      cancelScheduledSelectionAction();
      setSelectionAction(null);
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", scheduleSelectionAction);
    document.addEventListener("touchend", scheduleSelectionAction);
    document.addEventListener("keyup", scheduleSelectionAction);
    const viewer = viewerRef.current;
    viewer?.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      cancelScheduledSelectionAction();
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", scheduleSelectionAction);
      document.removeEventListener("touchend", scheduleSelectionAction);
      document.removeEventListener("keyup", scheduleSelectionAction);
      viewer?.removeEventListener("scroll", handleScroll);
    };
  }, [
    cancelScheduledSelectionAction,
    scheduleCurrentPageUpdate,
    scheduleForcedRenderUpdate,
    scheduleSelectionAction,
    setSelectionAction,
    viewerRef,
    viewStateRef,
  ]);

  useEffect(() => {
    scheduleForcedRenderUpdate();
    scheduleCurrentPageUpdate();
  }, [
    activeScale,
    rotation,
    pdfDocument,
    scheduleCurrentPageUpdate,
    scheduleForcedRenderUpdate,
    viewerSize.height,
    viewerSize.width,
  ]);

  useEffect(() => {
    if (!pdfDocument || !firstPageSize) return undefined;
    const restoreState = pendingRestoreRef.current;
    if (!restoreState) {
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (viewer) {
        if (restoreState.scrollTop > 0) {
          viewer.scrollTop = restoreState.scrollTop;
        } else if (restoreState.currentPage > 1) {
          const target = viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${restoreState.currentPage}"]`);
          target?.scrollIntoView({ block: "start" });
        } else {
          viewer.scrollTop = 0;
        }
        viewStateRef.current.scrollTop = viewer.scrollTop;
      }
      setCurrentPage(restoreState.currentPage);
      setPageInput(String(restoreState.currentPage));
      pendingRestoreRef.current = null;
      scheduleForcedRenderUpdate();
      scheduleCurrentPageUpdate();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    firstPageSize,
    pdfDocument,
    scheduleCurrentPageUpdate,
    scheduleForcedRenderUpdate,
    pendingRestoreRef,
    setCurrentPage,
    setPageInput,
    viewerRef,
    viewStateRef,
  ]);

  return { scheduleCurrentPageUpdate, scheduleForcedRenderUpdate, handlePageVisibilityChange };
}
