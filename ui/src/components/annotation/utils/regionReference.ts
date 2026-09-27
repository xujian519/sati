/**
 * 由一次区域选区产出「图片区域」引用。
 *
 * 标注面板接管图片族预览后，原先 `ImagePreview` 提供的"框选一块发给智能体"随之消失
 * （见 2026-09-28 决策记录）。这里让面板复刻那条能力，并与 PdfPreview / 表格预览共用
 * 同一个 region 引用契约——不新增引用种类，也不动提示块。
 */
import { createImageRegionContentReference, type ImageRegionContentReference } from "../../../types/contentReference";

/** 一次区域选区捕获到的东西（与 `RegionSelectionOverlay` 的 `CapturedRegion` 同形）。 */
export type RegionCapture = {
  /** 相对图面的归一化矩形。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 裁出的 PNG（composer 侧载荷）。 */
  dataUrl: string;
  /** 裁图的实际像素尺寸。 */
  width: number;
  height: number;
};

export type BuildRegionReferenceArgs = {
  projectName: string | undefined;
  /** 目标文件路径（编辑器给的形态，与标注引用同一来源）。 */
  relativePath: string;
  fileName: string;
  mimeType: string;
  /** 文件字节数（引用的 revision，供同源比较；未知则省略）。 */
  fileSize: number | undefined;
  /** 落点：SVG 附图自身，还是栅格图。 */
  surface: "figure" | "image";
  capture: RegionCapture;
};

/** 组装一条图片区域引用。 */
export function buildRegionReference({
  projectName,
  relativePath,
  fileName,
  mimeType,
  fileSize,
  surface,
  capture,
}: BuildRegionReferenceArgs): ImageRegionContentReference {
  return createImageRegionContentReference({
    selectionMode: "region",
    source: {
      ...(projectName === undefined ? {} : { projectName }),
      relativePath,
      fileName,
      mimeType,
      ...(fileSize === undefined ? {} : { revision: { size: fileSize } }),
    },
    renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
    locator: { surface, rect: capture.rect },
    image: {
      name: `reference-${fileName}-${Date.now()}.png`,
      mimeType: "image/png",
      width: capture.width,
      height: capture.height,
      dataUrl: capture.dataUrl,
    },
  });
}
