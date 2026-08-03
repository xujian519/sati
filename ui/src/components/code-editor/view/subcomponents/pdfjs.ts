// Re-export the pdfjs-dist legacy build, which polyfills ES2025
// Map.prototype.getOrInsertComputed so it works in older Chromium/Electron runtimes.
// Type declarations are taken from the main package entry so callers stay typed.
import * as pdfjsImpl from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  getDocument as GetDocumentFn,
  GlobalWorkerOptions as GlobalWorkerOptionsType,
  PDFDocumentLoadingTask as PDFDocumentLoadingTaskType,
  PDFDocumentProxy as PDFDocumentProxyType,
  RenderTask as RenderTaskType,
  TextLayer as TextLayerCtor,
} from "pdfjs-dist";

export const getDocument = pdfjsImpl.getDocument as unknown as typeof GetDocumentFn;
export const GlobalWorkerOptions = pdfjsImpl.GlobalWorkerOptions as unknown as typeof GlobalWorkerOptionsType;
export const TextLayer = pdfjsImpl.TextLayer as unknown as typeof TextLayerCtor;

export type PDFDocumentLoadingTask = PDFDocumentLoadingTaskType;
export type PDFDocumentProxy = PDFDocumentProxyType;
export type RenderTask = RenderTaskType;
export type TextLayer = InstanceType<typeof TextLayerCtor>;
