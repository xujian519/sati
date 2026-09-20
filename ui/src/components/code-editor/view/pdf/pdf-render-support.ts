import type { PageViewport } from "pdfjs-dist";
import * as pdfjs from "../subcomponents/pdfjs";

export function ignorePdfCleanupError(callback: () => unknown): void {
  try {
    const result = callback();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // PDF.js cleanup can throw when a render/load task has already finished or was already cancelled.
  }
}

export type PdfPageProxy = Awaited<ReturnType<pdfjs.PDFDocumentProxy["getPage"]>>;

/**
 * Size a canvas for devicePixelRatio-sharp rendering and start the page render task.
 * Shared by the main page renderer and the thumbnail renderer.
 */
export function setupPageCanvasRender(
  page: PdfPageProxy,
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
): pdfjs.RenderTask {
  const outputScale = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  return page.render({
    canvas,
    viewport,
    transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
  });
}
