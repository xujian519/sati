import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  createDocumentSelectionReference,
  type DocumentSelectionReference,
  type DocumentSelectionSource,
} from '../../../../types/documentSelection';

type PdfDocumentPreviewProps = {
  blob: Blob;
  projectName?: string;
  fileName: string;
  filePath: string;
  source: DocumentSelectionSource;
  loadingOverlay?: string | null;
};

type PdfSelectionAction = {
  top: number;
  left: number;
  reference: DocumentSelectionReference;
};

type PdfPageProps = {
  pdfDocument: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  targetWidth: number;
  onPageText: (pageNumber: number, text: string) => void;
};

const PAGE_HORIZONTAL_PADDING = 32;
const MAX_PAGE_WIDTH = 980;
const MIN_PAGE_WIDTH = 320;
const CONTEXT_RADIUS = 500;

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildSurroundingText(documentText: string, selectedText: string): string {
  const normalizedDocument = normalizeText(documentText);
  const normalizedSelected = normalizeText(selectedText);
  if (!normalizedDocument || !normalizedSelected) return '';

  const index = normalizedDocument.indexOf(normalizedSelected);
  if (index < 0) return normalizedDocument.slice(0, CONTEXT_RADIUS * 2).trim();

  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(normalizedDocument.length, index + normalizedSelected.length + CONTEXT_RADIUS);
  return normalizedDocument.slice(start, end).trim();
}

function getOccurrenceIndex(documentText: string, selectedText: string): number | null {
  const normalizedDocument = normalizeText(documentText);
  const normalizedSelected = normalizeText(selectedText);
  if (!normalizedDocument || !normalizedSelected) return null;
  return normalizedDocument.includes(normalizedSelected) ? 1 : null;
}

function getSelectedPageNumbers(root: HTMLElement, range: Range): number[] {
  const pages = Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page-number]'));
  return pages
    .filter((page) => {
      try {
        return range.intersectsNode(page);
      } catch {
        return false;
      }
    })
    .map((page) => Number.parseInt(page.dataset.pdfPageNumber || '', 10))
    .filter((pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0);
}

function getClosestElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function PdfPage({ pdfDocument, pageNumber, targetWidth, onPageText }: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [pageSize, setPageSize] = useState({ width: targetWidth, height: Math.round(targetWidth * 1.414), scale: 1 });
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const node = pageRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '900px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || !canvasRef.current || !textLayerRef.current || targetWidth <= 0) return undefined;

    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;

    const renderPage = async () => {
      try {
        setRenderError(null);
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = targetWidth / baseViewport.width;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const textLayerContainer = textLayerRef.current;
        if (!canvas || !textLayerContainer) return;

        const outputScale = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height, scale });

        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        onPageText(
          pageNumber,
          textContent.items
            .map((item) => ('str' in item ? item.str : ''))
            .filter(Boolean)
            .join(' '),
        );

        textLayerContainer.replaceChildren();
        textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        await textLayer.render();
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [isVisible, onPageText, pageNumber, pdfDocument, targetWidth]);

  const pageStyle = {
    width: pageSize.width,
    height: pageSize.height,
    '--scale-factor': pageSize.scale,
    '--user-unit': 1,
    '--total-scale-factor': pageSize.scale,
  } as CSSProperties;

  return (
    <div
      ref={pageRef}
      data-pdf-page-number={pageNumber}
      className="relative mx-auto my-5 bg-white shadow-sm ring-1 ring-neutral-200 dark:ring-neutral-800"
      style={pageStyle}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
      {renderError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-4 text-center text-[12px] text-red-500 dark:bg-neutral-950/90">
          {renderError}
        </div>
      ) : null}
    </div>
  );
}

export default function PdfDocumentPreview({
  blob,
  projectName,
  fileName,
  filePath,
  source,
  loadingOverlay = null,
}: PdfDocumentPreviewProps) {
  const { t } = useTranslation('codeEditor');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pageTextRef = useRef(new Map<number, string>());
  const [pdfDocument, setPdfDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewerWidth, setViewerWidth] = useState(0);
  const [selectionAction, setSelectionAction] = useState<PdfSelectionAction | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const updateWidth = () => {
      setViewerWidth(Math.max(0, root.clientWidth - PAGE_HORIZONTAL_PADDING * 2));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    pageTextRef.current = new Map();
    setPdfDocument(null);
    setErrorMessage(null);
    setSelectionAction(null);

    const loadPdf = async () => {
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data });
        const nextDocument = await loadingTask.promise;
        if (!cancelled) {
          setPdfDocument(nextDocument);
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
      loadingTask?.destroy();
    };
  }, [blob]);

  const targetWidth = useMemo(
    () => Math.max(MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, viewerWidth || MAX_PAGE_WIDTH)),
    [viewerWidth],
  );

  const handlePageText = useCallback((pageNumber: number, text: string) => {
    pageTextRef.current.set(pageNumber, text);
  }, []);

  const updateSelectionAction = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionAction(null);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) {
      setSelectionAction(null);
      return;
    }

    const anchorElement = getClosestElement(anchorNode);
    const focusElement = getClosestElement(focusNode);
    if (!anchorElement?.closest('.textLayer') || !focusElement?.closest('.textLayer')) {
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
    const rootRect = root.getBoundingClientRect();
    const pageNumbers = getSelectedPageNumbers(root, range);
    const sortedPageTexts = Array.from(pageTextRef.current.entries())
      .sort(([left], [right]) => left - right);
    const documentText = sortedPageTexts.map(([, text]) => text).join('\n');
    const pageText = pageNumbers.length > 0
      ? pageNumbers.map((pageNumber) => pageTextRef.current.get(pageNumber) || '').join('\n')
      : documentText;
    const surroundingText = buildSurroundingText(pageText || documentText, selectedText);
    const occurrenceIndex = getOccurrenceIndex(documentText || pageText, selectedText);
    const reference = createDocumentSelectionReference({
      projectName,
      fileName,
      filePath,
      source,
      pageNumbers,
      selectedText,
      surroundingText,
      occurrenceIndex,
    });

    const left = Math.max(12, Math.min(root.clientWidth - 190, rect.left - rootRect.left + root.scrollLeft + rect.width / 2 - 80));
    const top = Math.max(12, rect.top - rootRect.top + root.scrollTop - 42);
    setSelectionAction({ top, left, reference });
  }, [fileName, filePath, projectName, source]);

  useEffect(() => {
    const handleSelectionChange = () => updateSelectionAction();
    const handleScroll = () => setSelectionAction(null);

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleSelectionChange);
    document.addEventListener('keyup', handleSelectionChange);
    const root = rootRef.current;
    root?.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', handleSelectionChange);
      document.removeEventListener('keyup', handleSelectionChange);
      root?.removeEventListener('scroll', handleScroll);
    };
  }, [updateSelectionAction]);

  const handleAddReference = () => {
    if (!selectionAction) return;
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', {
      detail: selectionAction.reference,
    }));
    window.getSelection()?.removeAllRanges();
    setSelectionAction(null);
  };

  if (errorMessage) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white p-6 text-center text-[13px] text-red-500 dark:bg-neutral-950">
        {errorMessage}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-auto bg-neutral-100 dark:bg-neutral-900">
      {!pdfDocument ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
        </div>
      ) : (
        <div className="px-4 py-2">
          {Array.from({ length: pdfDocument.numPages }, (_, index) => (
            <PdfPage
              key={`${filePath}-${index + 1}-${targetWidth}`}
              pdfDocument={pdfDocument}
              pageNumber={index + 1}
              targetWidth={targetWidth}
              onPageText={handlePageText}
            />
          ))}
        </div>
      )}

      {loadingOverlay ? (
        <div className="absolute left-3 top-3 z-10 rounded-md border border-neutral-200 bg-white/95 px-3 py-1.5 text-[12px] text-neutral-600 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95 dark:text-neutral-300">
          {loadingOverlay}
        </div>
      ) : null}

      {selectionAction ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleAddReference}
          className="absolute z-20 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-900 shadow-lg transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
          style={{ top: selectionAction.top, left: selectionAction.left }}
        >
          {t('selection.chatInPilotDeck')}
        </button>
      ) : null}
    </div>
  );
}
