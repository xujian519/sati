import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { getRotatedPageSize, type PageSize, type Rotation } from "../../../utils/pdfViewport";
import { renderPdfSearchHighlights, type PdfSearchMatch } from "../../../utils/pdfSearch";
import { PAGE_RENDER_ROOT_MARGIN } from "../pdf-constants";
import { ignorePdfCleanupError, setupPageCanvasRender } from "../pdf-render-support";
import * as pdfjs from "../../subcomponents/pdfjs";

export type PdfPageProps = {
  pdfDocument: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: Rotation;
  basePageSize: PageSize;
  viewerRootRef: RefObject<HTMLDivElement | null>;
  forceRender: boolean;
  searchMatches: PdfSearchMatch[];
  selectedSearchMatchId: string | null;
  onPageText: (pageNumber: number, text: string, textItems: string[]) => void;
  onPageVisibilityChange: (pageNumber: number, visible: boolean) => void;
};

export default function PdfPage({
  pdfDocument,
  pageNumber,
  scale,
  rotation,
  basePageSize,
  viewerRootRef,
  forceRender,
  searchMatches,
  selectedSearchMatchId,
  onPageText,
  onPageVisibilityChange,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerMappingRef = useRef<{
    textDivs: HTMLElement[];
    textItems: string[];
  } | null>(null);
  const [isIntersectionVisible, setIsIntersectionVisible] = useState(false);
  const estimatedPageSize = useMemo(() => {
    const rotated = getRotatedPageSize(basePageSize, rotation);
    return {
      width: Math.max(1, rotated.width * scale),
      height: Math.max(1, rotated.height * scale),
      scale,
    };
  }, [basePageSize, rotation, scale]);
  const [pageSize, setPageSize] = useState(estimatedPageSize);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [textLayerRenderVersion, setTextLayerRenderVersion] = useState(0);
  const shouldRender = isIntersectionVisible || forceRender;

  useEffect(() => {
    setPageSize(estimatedPageSize);
  }, [estimatedPageSize]);

  useEffect(() => {
    const node = pageRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        const nextVisible = entries.some(entry => entry.isIntersecting);
        setIsIntersectionVisible(nextVisible);
        onPageVisibilityChange(pageNumber, nextVisible);
      },
      {
        root: viewerRootRef.current,
        rootMargin: PAGE_RENDER_ROOT_MARGIN,
      },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      onPageVisibilityChange(pageNumber, false);
    };
  }, [onPageVisibilityChange, pageNumber, viewerRootRef]);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current || !textLayerRef.current || scale <= 0) {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.style.width = "";
        canvas.style.height = "";
      }
      textLayerRef.current?.replaceChildren();
      textLayerMappingRef.current = null;
      setRenderError(null);
      setIsRendering(false);
      setHasRendered(false);
      return undefined;
    }

    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;

    const renderPage = async () => {
      try {
        setRenderError(null);
        setIsRendering(true);
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        const textLayerContainer = textLayerRef.current;
        if (!canvas || !textLayerContainer) return;

        setPageSize({ width: viewport.width, height: viewport.height, scale });

        renderTask = setupPageCanvasRender(page, canvas, viewport);
        await renderTask.promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        textLayerContainer.replaceChildren();
        textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) {
          const textItems = textLayer.textContentItemsStr;
          textLayerMappingRef.current = {
            textDivs: textLayer.textDivs,
            textItems,
          };
          onPageText(pageNumber, textItems.join(" "), textItems);
          setTextLayerRenderVersion(version => version + 1);
          setHasRendered(true);
          setIsRendering(false);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          const name = error instanceof Error ? error.name : "";
          if (name !== "RenderingCancelledException" && !message.toLowerCase().includes("cancelled")) {
            setRenderError(message);
          }
          setIsRendering(false);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      ignorePdfCleanupError(() => renderTask?.cancel?.());
      ignorePdfCleanupError(() => textLayer?.cancel?.());
    };
  }, [shouldRender, onPageText, pageNumber, pdfDocument, rotation, scale]);

  useEffect(() => {
    const mapping = textLayerMappingRef.current;
    if (!mapping || textLayerRenderVersion === 0) return undefined;

    const selectedElement = renderPdfSearchHighlights(
      mapping.textDivs,
      mapping.textItems,
      searchMatches,
      selectedSearchMatchId,
    );
    if (!selectedElement) return undefined;

    const frame = window.requestAnimationFrame(() => {
      selectedElement.scrollIntoView({
        block: "center",
        inline: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchMatches, selectedSearchMatchId, textLayerRenderVersion]);

  const pageStyle = {
    width: pageSize.width,
    height: pageSize.height,
    "--scale-factor": pageSize.scale,
    "--user-unit": 1,
    "--total-scale-factor": pageSize.scale,
  } as CSSProperties;

  return (
    <div
      ref={pageRef}
      data-pdf-page-number={pageNumber}
      className="relative mx-auto my-5 bg-white shadow-xs ring-1 ring-neutral-200 dark:ring-neutral-800"
      style={pageStyle}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
      {shouldRender && (isRendering || !hasRendered) && !renderError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-neutral-950">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-500 dark:border-neutral-800 dark:border-t-neutral-300" />
        </div>
      ) : null}
      {renderError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-4 text-center text-[12px] text-red-500 dark:bg-neutral-950/90">
          {renderError}
        </div>
      ) : null}
    </div>
  );
}
