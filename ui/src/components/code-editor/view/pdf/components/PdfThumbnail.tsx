import { useEffect, useRef, useState, type RefObject } from "react";
import type { Rotation } from "../../../utils/pdfViewport";
import { THUMBNAIL_MAX_HEIGHT, THUMBNAIL_MAX_WIDTH, THUMBNAIL_RENDER_ROOT_MARGIN } from "../pdf-constants";
import { ignorePdfCleanupError, setupPageCanvasRender } from "../pdf-render-support";
import * as pdfjs from "../../subcomponents/pdfjs";

export type PdfThumbnailProps = {
  pdfDocument: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  rotation: Rotation;
  active: boolean;
  navigationRootRef: RefObject<HTMLDivElement | null>;
  label: string;
  onSelect: (pageNumber: number) => void;
};

export default function PdfThumbnail({
  pdfDocument,
  pageNumber,
  rotation,
  active,
  navigationRootRef,
  label,
  onSelect,
}: PdfThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shouldRender, setShouldRender] = useState(pageNumber <= 3);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    const node = buttonRef.current;
    if (!node || shouldRender) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      {
        root: navigationRootRef.current,
        rootMargin: THUMBNAIL_RENDER_ROOT_MARGIN,
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [navigationRootRef, shouldRender]);

  useEffect(() => {
    if (!active) return;
    buttonRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current) return undefined;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;

    const renderThumbnail = async () => {
      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const baseViewport = page.getViewport({ scale: 1, rotation });
        const scale = Math.min(THUMBNAIL_MAX_WIDTH / baseViewport.width, THUMBNAIL_MAX_HEIGHT / baseViewport.height);
        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        if (!canvas) return;
        renderTask = setupPageCanvasRender(page, canvas, viewport);
        await renderTask.promise;
        if (!cancelled) setRenderError(false);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (!cancelled && !message.includes("cancelled")) {
          setRenderError(true);
        }
      }
    };

    void renderThumbnail();
    return () => {
      cancelled = true;
      ignorePdfCleanupError(() => renderTask?.cancel?.());
    };
  }, [pageNumber, pdfDocument, rotation, shouldRender]);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-pdf-thumbnail-page={pageNumber}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
      onClick={() => onSelect(pageNumber)}
      className={[
        "group flex w-full flex-col items-center gap-1.5 rounded-md border px-2 py-2 text-[11px] outline-hidden transition-colors",
        "focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-neutral-950",
        active
          ? "border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-200"
          : "border-transparent text-neutral-500 hover:border-neutral-300 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:bg-neutral-900",
      ].join(" ")}
    >
      <span className="flex h-[124px] w-full items-center justify-center overflow-hidden rounded-sm bg-white shadow-xs ring-1 ring-neutral-200 dark:ring-neutral-700">
        {renderError ? (
          <span className="px-2 text-center text-[10px] text-red-500">!</span>
        ) : (
          <canvas ref={canvasRef} className="block max-h-full max-w-full" />
        )}
      </span>
      <span className="font-medium tabular-nums">{pageNumber}</span>
    </button>
  );
}
