import { useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DocumentSelectionSource } from "../../../../../types/documentSelection";
import type { PdfNavigationMode } from "../../../utils/documentPreview";
import { resolvePdfOutline, type PdfOutlineItem } from "../../../utils/pdfOutline";
import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  getRotatedPageSize,
  resolveActiveScale,
  type PageSize,
  type Rotation,
  type ZoomMode,
} from "../../../utils/pdfViewport";
import * as pdfjs from "../../subcomponents/pdfjs";
import {
  DEFAULT_VIEW_STATE,
  PAGE_HORIZONTAL_PADDING,
  PAGE_VERTICAL_PADDING,
  PDF_RANGE_CHUNK_SIZE,
} from "../pdf-constants";
import { ignorePdfCleanupError } from "../pdf-render-support";
import type { NavigationView, PdfSelectionAction, PdfViewState, ViewerSize } from "../pdf-types";

type UsePdfViewportOptions = {
  /** 当前文件描述（决定 `fileKey`，换文件即重载）。 */
  file: {
    blob?: Blob;
    url?: string;
    source: DocumentSelectionSource;
    projectName?: string;
    filePath: string;
    viewKey: string;
  };
  /** 查看器容器与尺寸。 */
  surface: {
    viewerRef: RefObject<HTMLDivElement | null>;
    viewerSize: ViewerSize;
    setViewerSize: Dispatch<SetStateAction<ViewerSize>>;
  };
  /** 已加载文档及其首页尺寸、错误。 */
  doc: {
    firstPageSize: PageSize | null;
    setFirstPageSize: Dispatch<SetStateAction<PageSize | null>>;
    setPdfDocument: Dispatch<SetStateAction<pdfjs.PDFDocumentProxy | null>>;
    setErrorMessage: Dispatch<SetStateAction<string | null>>;
  };
  /** 会被持久化到 `viewStateRef` 的视口状态。 */
  view: {
    currentPage: number;
    setCurrentPage: Dispatch<SetStateAction<number>>;
    zoomMode: ZoomMode;
    setZoomMode: Dispatch<SetStateAction<ZoomMode>>;
  };
  scale: {
    customScale: number;
    setCustomScale: Dispatch<SetStateAction<number>>;
    rotation: Rotation;
    setRotation: Dispatch<SetStateAction<Rotation>>;
  };
  /** 缩放/页码输入框。 */
  inputs: {
    zoomInputFocused: boolean;
    setZoomInput: Dispatch<SetStateAction<string>>;
    pageInputFocused: boolean;
    setPageInput: Dispatch<SetStateAction<string>>;
  };
  /** 换文件时需要复位的共享状态。 */
  reset: {
    resetSearch: () => void;
    setSelectionAction: Dispatch<SetStateAction<PdfSelectionAction | null>>;
    setForcedRenderPageNumbers: Dispatch<SetStateAction<Set<number>>>;
  };
  /** 换文件时需要复位的共享引用。 */
  refs: {
    pageTextRef: RefObject<Map<number, string>>;
    pageTextItemsRef: RefObject<Map<number, string[]>>;
    visiblePageNumbersRef: RefObject<Set<number>>;
    forcedRenderPageNumbersRef: RefObject<Set<number>>;
  };
  /** 导航栏（大纲/缩略图）状态。 */
  navigation: {
    setNavigationOpen: Dispatch<SetStateAction<boolean>>;
    setNavigationView: Dispatch<SetStateAction<NavigationView>>;
    setOutlineItems: Dispatch<SetStateAction<PdfOutlineItem[]>>;
  };
  navigationMode: PdfNavigationMode;
};

/**
 * PDF 视口状态机：文档加载、随 `fileKey` 的视口快照/恢复、fit 比例与缩放百分比、
 * 缩放/页码输入框的同步。
 *
 * 从 `view/subcomponents/PdfDocumentPreview.tsx` 抽出（#159 N07）。抽出时保持了内部
 * effect 的**原始相对顺序**：先把视口字段同步进 `viewStateRef`，最后才跑加载 effect——
 * 加载 effect 读 `viewStateRef` 做快照，顺序颠倒会晚一帧、把上一个文件的位置恢复过来。
 */
export function usePdfViewport({
  file,
  surface,
  doc,
  view,
  scale,
  inputs,
  reset,
  refs,
  navigation,
  navigationMode,
}: UsePdfViewportOptions) {
  const { blob, url, source, projectName, filePath, viewKey } = file;
  const { viewerRef, viewerSize, setViewerSize } = surface;
  const { firstPageSize, setFirstPageSize, setPdfDocument, setErrorMessage } = doc;
  const { currentPage, setCurrentPage, zoomMode, setZoomMode } = view;
  const { customScale, setCustomScale, rotation, setRotation } = scale;
  const { zoomInputFocused, setZoomInput, pageInputFocused, setPageInput } = inputs;
  const { resetSearch, setSelectionAction, setForcedRenderPageNumbers } = reset;
  const { pageTextRef, pageTextItemsRef, visiblePageNumbersRef, forcedRenderPageNumbersRef } = refs;
  const { setNavigationOpen, setNavigationView, setOutlineItems } = navigation;
  const viewStateRef = useRef<PdfViewState>({ ...DEFAULT_VIEW_STATE });
  const fileKeyRef = useRef<string | null>(null);
  const pendingRestoreRef = useRef<PdfViewState | null>(null);
  const fileKey = `${source}:${projectName || ""}:${filePath}:${viewKey}`;

  useEffect(() => {
    viewStateRef.current.currentPage = currentPage;
  }, [currentPage]);

  useEffect(() => {
    viewStateRef.current.zoomMode = zoomMode;
  }, [zoomMode]);

  useEffect(() => {
    viewStateRef.current.customScale = customScale;
  }, [customScale]);

  useEffect(() => {
    viewStateRef.current.rotation = rotation;
  }, [rotation]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return undefined;
    const updateSize = () => {
      setViewerSize({
        width: viewer.clientWidth,
        height: viewer.clientHeight,
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewer);
    return () => observer.disconnect();
  }, [setViewerSize, viewerRef]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    const viewer = viewerRef.current;
    const isSameFile = fileKeyRef.current === fileKey;
    const nextViewState = isSameFile
      ? {
          ...viewStateRef.current,
          scrollTop: viewer?.scrollTop ?? viewStateRef.current.scrollTop,
        }
      : { ...DEFAULT_VIEW_STATE };
    fileKeyRef.current = fileKey;
    pendingRestoreRef.current = nextViewState;
    viewStateRef.current = nextViewState;
    pageTextRef.current = new Map();
    pageTextItemsRef.current = new Map();
    visiblePageNumbersRef.current = new Set();
    forcedRenderPageNumbersRef.current = new Set();
    setForcedRenderPageNumbers(new Set());
    setPdfDocument(null);
    setFirstPageSize(null);
    setErrorMessage(null);
    setSelectionAction(null);
    setCurrentPage(nextViewState.currentPage);
    setPageInput(String(nextViewState.currentPage));
    setRotation(nextViewState.rotation);
    setZoomMode(nextViewState.zoomMode);
    setCustomScale(nextViewState.customScale);
    setNavigationOpen(navigationMode !== "none");
    setNavigationView("thumbnails");
    setOutlineItems([]);
    resetSearch();

    const loadPdf = async () => {
      try {
        if (!url && !blob) {
          throw new Error("PDF source is not available.");
        }

        if (url) {
          loadingTask = pdfjs.loadDocument({
            url,
            rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
            disableStream: true,
            disableAutoFetch: true,
          });
        } else {
          const data = new Uint8Array(await blob!.arrayBuffer());
          if (cancelled) return;
          loadingTask = pdfjs.loadDocument({ data });
        }

        const nextDocument = await loadingTask.promise;
        if (cancelled) return;
        const restoredPage = clamp(nextViewState.currentPage, 1, Math.max(1, nextDocument.numPages));
        if (restoredPage !== nextViewState.currentPage) {
          const clampedViewState = {
            ...nextViewState,
            currentPage: restoredPage,
            scrollTop: 0,
          };
          pendingRestoreRef.current = clampedViewState;
          viewStateRef.current = clampedViewState;
          setCurrentPage(restoredPage);
          setPageInput(String(restoredPage));
        }
        const firstPage = await nextDocument.getPage(1);
        if (cancelled) return;
        const viewport = firstPage.getViewport({ scale: 1 });
        setFirstPageSize({ width: viewport.width, height: viewport.height });
        setPdfDocument(nextDocument);
        if (navigationMode === "pages") {
          try {
            const rawOutline = await nextDocument.getOutline();
            const nextOutlineItems = await resolvePdfOutline(nextDocument, rawOutline);
            if (cancelled) return;
            setOutlineItems(nextOutlineItems);
            if (nextOutlineItems.length > 0) {
              setNavigationView("outline");
            }
          } catch {
            // Outline parse failures degrade to an empty outline — thumbnails stay usable.
            if (!cancelled) {
              setOutlineItems([]);
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }
    };

    loadPdf();
    return () => {
      cancelled = true;
      ignorePdfCleanupError(() => loadingTask?.destroy?.());
    };
  }, [
    blob,
    fileKey,
    navigationMode,
    resetSearch,
    url,
    forcedRenderPageNumbersRef,
    pageTextItemsRef,
    pageTextRef,
    setCurrentPage,
    setCustomScale,
    setErrorMessage,
    setFirstPageSize,
    setForcedRenderPageNumbers,
    setNavigationOpen,
    setNavigationView,
    setOutlineItems,
    setPageInput,
    setPdfDocument,
    setRotation,
    setSelectionAction,
    setZoomMode,
    viewerRef,
    visiblePageNumbersRef,
  ]);

  const fitScales = useMemo(() => {
    if (!firstPageSize || viewerSize.width <= 0 || viewerSize.height <= 0) {
      return { fitWidth: 1, fitPage: 1 };
    }
    const rotatedSize = getRotatedPageSize(firstPageSize, rotation);
    const availableWidth = Math.max(1, viewerSize.width - PAGE_HORIZONTAL_PADDING * 2);
    const availableHeight = Math.max(1, viewerSize.height - PAGE_VERTICAL_PADDING);
    const fitWidth = availableWidth / rotatedSize.width;
    const fitPage = Math.min(fitWidth, availableHeight / rotatedSize.height);
    return {
      fitWidth: clamp(fitWidth, MIN_SCALE, MAX_SCALE),
      fitPage: clamp(fitPage, MIN_SCALE, MAX_SCALE),
    };
  }, [firstPageSize, rotation, viewerSize.height, viewerSize.width]);

  const activeScale = resolveActiveScale(zoomMode, fitScales, customScale);

  const zoomPercent = Math.round(activeScale * 100);

  useEffect(() => {
    if (!zoomInputFocused) {
      setZoomInput(`${zoomPercent}%`);
    }
  }, [zoomInputFocused, zoomPercent, setZoomInput]);

  useEffect(() => {
    if (!pageInputFocused) {
      setPageInput(String(currentPage));
    }
  }, [currentPage, pageInputFocused, setPageInput]);

  return { viewStateRef, pendingRestoreRef, activeScale, zoomPercent };
}
