import type { ContentReference } from "../../../../types/contentReference";
import type { Rotation, ZoomMode } from "../../utils/pdfViewport";

export type PdfSelectionAction = {
  top: number;
  left: number;
  reference: ContentReference;
};

export type ViewerSize = {
  width: number;
  height: number;
};

// `PageSize` / `ZoomMode` / `Rotation` 与缩放、页码解析等纯函数同住 `utils/pdfViewport.ts`。
export type NavigationView = "thumbnails" | "outline";

export type PdfViewState = {
  scrollTop: number;
  currentPage: number;
  zoomMode: ZoomMode;
  customScale: number;
  rotation: Rotation;
};
