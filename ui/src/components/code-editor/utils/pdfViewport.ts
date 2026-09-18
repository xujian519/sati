/**
 * PDF 视口数学：缩放模式/旋转/尺寸换算与缩放、页码输入解析。
 *
 * 这些函数原先内联在 `view/subcomponents/PdfDocumentPreview.tsx` 里——它们不依赖 React、
 * 不碰 DOM，却是"读那个 1885 行组件时最容易被埋掉"的部分：抽出后可直接单测（#159 N07）。
 */

export type PageSize = {
  width: number;
  height: number;
};

export type ZoomMode = "fitPage" | "fitWidth" | "custom";
export type Rotation = 0 | 90 | 180 | 270;

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 0.25;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isQuarterTurn(rotation: Rotation): boolean {
  return rotation === 90 || rotation === 270;
}

export function getRotatedPageSize(size: PageSize, rotation: Rotation): PageSize {
  return isQuarterTurn(rotation) ? { width: size.height, height: size.width } : size;
}

export function resolveActiveScale(
  zoomMode: ZoomMode,
  fitScales: { fitWidth: number; fitPage: number },
  customScale: number,
): number {
  if (zoomMode === "fitWidth") return fitScales.fitWidth;
  if (zoomMode === "fitPage") return fitScales.fitPage;
  return customScale;
}

export function parsePercentInput(value: string): number | null {
  const normalized = value.replace("%", "").trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed / 100, MIN_SCALE, MAX_SCALE);
}

export function parsePageInput(value: string, totalPages: number): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(clamp(parsed, 1, Math.max(1, totalPages)));
}
