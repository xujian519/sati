import type { PdfViewState } from "./pdf-types";

export const PAGE_HORIZONTAL_PADDING = 32;
export const PAGE_VERTICAL_PADDING = 40;
export const PDF_RANGE_CHUNK_SIZE = 256 * 1024;
export const PAGE_RENDER_ROOT_MARGIN = "1200px 0px";
export const THUMBNAIL_RENDER_ROOT_MARGIN = "600px 0px";
export const THUMBNAIL_MAX_WIDTH = 116;
export const THUMBNAIL_MAX_HEIGHT = 124;

export const DEFAULT_VIEW_STATE: PdfViewState = {
  scrollTop: 0,
  currentPage: 1,
  zoomMode: "fitPage",
  customScale: 1,
  rotation: 0,
};
