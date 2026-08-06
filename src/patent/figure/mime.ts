/**
 * src/patent/figure — sharp 图像格式到 MIME 类型的映射。
 *
 * 仅收录附图分析支持的格式（与 kimi 多模态声明对齐：jpeg/png/gif/webp）。
 */

/** sharp metadata().format → MIME 类型。 */
export const FIGURE_IMAGE_MIME_TYPES: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
