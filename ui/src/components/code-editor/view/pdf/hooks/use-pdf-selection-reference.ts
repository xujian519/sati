import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { UI_TIMEOUTS } from "../../../../../constants/timeouts";
import type { DocumentSelectionSource } from "../../../../../types/documentSelection";
import {
  createImageRegionContentReference,
  createTextContentReference,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from "../../../../../types/contentReference";
import type { PageSize } from "../../../utils/pdfViewport";
import {
  buildSurroundingText,
  getClosestElement,
  getOccurrenceIndex,
  getSelectedPageNumbers,
  getTextLayerText,
} from "../../../utils/pdfTextSelection";
import type { CapturedRegion } from "../../subcomponents/RegionSelectionOverlay";
import * as pdfjs from "../../subcomponents/pdfjs";
import type { PdfSelectionAction } from "../pdf-types";

type UsePdfSelectionReferenceOptions = {
  viewer: {
    viewerRef: RefObject<HTMLDivElement | null>;
    pageTextRef: RefObject<Map<number, string>>;
    pdfDocument: pdfjs.PDFDocumentProxy | null;
    firstPageSize: PageSize | null;
    currentPage: number;
  };
  selection: {
    selectionAction: PdfSelectionAction | null;
    setSelectionAction: Dispatch<SetStateAction<PdfSelectionAction | null>>;
    setReferenceMode: Dispatch<SetStateAction<ContentReferenceSelectionMode | null>>;
  };
  source: {
    blob?: Blob;
    fileName: string;
    filePath: string;
    projectName?: string;
    source: DocumentSelectionSource;
  };
};

/**
 * 选区 → 内容引用：把 PDF 文本层的选区转成 `ContentReference`（供"加入对话"浮动按钮）、
 * 区域选择模式的引用构造，以及选区防抖调度。
 *
 * 从 `view/subcomponents/PdfDocumentPreview.tsx` 抽出（#159 N07）。本 hook 自身**不含
 * effect**：原来那个"selectionchange/mouseup/touchend/keyup/scroll"监听 effect 与滚动调度
 * 互为一体，落在 `usePdfScrollTracking` 里，以保持主组件 effect 的原始执行顺序。
 */
export function usePdfSelectionReference({ viewer, selection, source: file }: UsePdfSelectionReferenceOptions) {
  const { viewerRef, pageTextRef, pdfDocument, firstPageSize, currentPage } = viewer;
  const { selectionAction, setSelectionAction, setReferenceMode } = selection;
  const { blob, fileName, filePath, projectName, source } = file;
  const selectionActionTimerRef = useRef<number | null>(null);

  const updateSelectionAction = useCallback(() => {
    const viewer = viewerRef.current;
    const selection = window.getSelection();
    if (!viewer || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionAction(null);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !viewer.contains(anchorNode) || !viewer.contains(focusNode)) {
      setSelectionAction(null);
      return;
    }

    const anchorElement = getClosestElement(anchorNode);
    const focusElement = getClosestElement(focusNode);
    if (!anchorElement?.closest(".textLayer") || !focusElement?.closest(".textLayer")) {
      setSelectionAction(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      setSelectionAction(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    const viewerRect = viewer.getBoundingClientRect();
    const pageNumbers = getSelectedPageNumbers(viewer, range);
    const sortedPageTexts = Array.from(pageTextRef.current.entries()).sort(([left], [right]) => left - right);
    const cachedDocumentText = sortedPageTexts.map(([, text]) => text).join("\n");
    const cachedPageText =
      pageNumbers.length > 0
        ? pageNumbers.map(pageNumber => pageTextRef.current.get(pageNumber) || "").join("\n")
        : cachedDocumentText;
    const domPageText = getTextLayerText(viewer, pageNumbers);
    const contextText = domPageText || cachedPageText || cachedDocumentText || selectedText;
    const surroundingText = buildSurroundingText(contextText, selectedText);
    const occurrenceIndex = getOccurrenceIndex(cachedDocumentText || contextText, selectedText);
    const firstPage = pageNumbers[0];
    const pageElement = firstPage ? viewer.querySelector<HTMLElement>(`[data-pdf-page-number="${firstPage}"]`) : null;
    const pageRect = pageElement?.getBoundingClientRect();
    const normalizedRect = pageRect
      ? {
          x: (rect.left - pageRect.left) / Math.max(1, pageRect.width),
          y: (rect.top - pageRect.top) / Math.max(1, pageRect.height),
          width: rect.width / Math.max(1, pageRect.width),
          height: rect.height / Math.max(1, pageRect.height),
        }
      : null;
    const reference = createTextContentReference({
      selectionMode: "text",
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        ...(blob ? { revision: { size: blob.size } } : {}),
      },
      renderer: {
        id: source,
        backend: source === "office-pdf" ? "libreoffice" : "builtin",
        locatorQuality: source === "office-pdf" ? "approximate" : "semantic",
      },
      locator: {
        surface: "page",
        pageNumbers,
        quote: { exact: selectedText },
        occurrenceIndex,
        ...(normalizedRect ? { rects: [normalizedRect] } : {}),
      },
      selectedText,
      surroundingText,
    });

    const left = Math.max(
      12,
      Math.min(viewer.clientWidth - 190, rect.left - viewerRect.left + viewer.scrollLeft + rect.width / 2 - 80),
    );
    const top = Math.max(12, rect.top - viewerRect.top + viewer.scrollTop - 42);
    setSelectionAction({ top, left, reference });
  }, [blob, fileName, filePath, projectName, source, pageTextRef, setSelectionAction, viewerRef]);

  const cancelScheduledSelectionAction = useCallback(() => {
    if (selectionActionTimerRef.current !== null) {
      window.clearTimeout(selectionActionTimerRef.current);
      selectionActionTimerRef.current = null;
    }
  }, []);

  const scheduleSelectionAction = useCallback(() => {
    cancelScheduledSelectionAction();
    selectionActionTimerRef.current = window.setTimeout(() => {
      selectionActionTimerRef.current = null;
      updateSelectionAction();
    }, UI_TIMEOUTS.SELECTION_ACTION_DEBOUNCE_MS);
  }, [cancelScheduledSelectionAction, updateSelectionAction]);

  const handleAddReference = () => {
    if (!selectionAction) return;
    window.dispatchEvent(
      new CustomEvent("sati:add-chat-reference", {
        detail: selectionAction.reference,
      }),
    );
    window.getSelection()?.removeAllRanges();
    setSelectionAction(null);
  };

  const referenceCapabilities: ReferenceCapabilities = {
    text: pdfDocument && firstPageSize ? { state: "available" } : { state: "loading", reason: "SURFACE_NOT_READY" },
    cells: { state: "unavailable", reason: "NO_CELL_MODEL" },
    region: pdfDocument && firstPageSize ? { state: "available" } : { state: "loading", reason: "SURFACE_NOT_READY" },
    recommendedMode: "text",
  };

  const handleReferenceMode = (mode: ContentReferenceSelectionMode) => {
    if (mode === "region") {
      window.getSelection()?.removeAllRanges();
      setSelectionAction(null);
      setReferenceMode("region");
      return;
    }
    setReferenceMode(null);
  };

  const handleRegionCommit = (capture: CapturedRegion) => {
    const surfaceNumber = capture.pageNumber || currentPage;
    const imageName = `reference-${fileName}-page-${surfaceNumber}-${Date.now()}.png`;
    const reference = createImageRegionContentReference({
      selectionMode: "region",
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        ...(blob ? { revision: { size: blob.size } } : {}),
      },
      renderer: {
        id: source,
        backend: source === "office-pdf" ? "libreoffice" : "builtin",
        locatorQuality: "visual",
      },
      locator: {
        surface: "page",
        pageNumber: surfaceNumber,
        rect: capture.rect,
      },
      image: {
        name: imageName,
        mimeType: "image/png",
        width: capture.width,
        height: capture.height,
        dataUrl: capture.dataUrl,
      },
      nearbyText: capture.nearbyText,
    });
    window.dispatchEvent(new CustomEvent("sati:add-chat-reference", { detail: reference }));
    setReferenceMode(null);
  };

  return {
    cancelScheduledSelectionAction,
    scheduleSelectionAction,
    handleAddReference,
    referenceCapabilities,
    handleReferenceMode,
    handleRegionCommit,
  };
}
