// Re-export the pdfjs-dist legacy build, which polyfills ES2025
// Map.prototype.getOrInsertComputed so it works in older Chromium/Electron runtimes.
// Type declarations are taken from the main package entry so callers stay typed.
import * as pdfjsImpl from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  getDocument as GetDocumentFn,
  PDFDocumentLoadingTask as PDFDocumentLoadingTaskType,
  PDFDocumentProxy as PDFDocumentProxyType,
  RenderTask as RenderTaskType,
  TextLayer as TextLayerCtor,
} from "pdfjs-dist";

// legacy 构建的 `pdf.d.mts` 是 `export * from "pdfjs-dist"` 再导出，两处类型同源，
// 直接透传；此前的双断言系「legacy 构建未随包发类型」时期的遗留（#646 sweep P1.3）。
const getDocumentImpl = pdfjsImpl.getDocument;

export const getDocument = getDocumentImpl;
export const GlobalWorkerOptions = pdfjsImpl.GlobalWorkerOptions;
export const TextLayer = pdfjsImpl.TextLayer;

type GetDocumentOptions = Parameters<typeof GetDocumentFn>[0];

/**
 * Load a PDF document with the Sati-wide pdfjs-dist configuration.
 *
 * pdfjs-dist 6.x requires an explicit `wasmUrl` for WebAssembly image decoders
 * (JBIG2, OpenJPEG, QCMS) to be fetched from the worker thread. In Sati these
 * wasm files are served at `/wasm/` by the build/dev server; this helper injects
 * that URL so callers don't need to know the deployment detail.
 */
export function loadDocument(options: Omit<GetDocumentOptions, "wasmUrl">): PDFDocumentLoadingTaskType {
  return getDocumentImpl({ ...options, wasmUrl: "/wasm/" });
}

export type PDFDocumentLoadingTask = PDFDocumentLoadingTaskType;
export type PDFDocumentProxy = PDFDocumentProxyType;
export type RenderTask = RenderTaskType;
export type TextLayer = InstanceType<typeof TextLayerCtor>;
