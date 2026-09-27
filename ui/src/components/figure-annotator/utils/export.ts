/**
 * 合成"审阅图"——原图 + 全部标注，作为一张独立 SVG 光栅化成 PNG。
 *
 * 独立的意思是：不引用任何外部资源、只用系统字体，这样送进 `<img>` 解码不会因跨域或
 * 字体缺失而失败；智能体收到的就是用户确认过的那张图。
 */
import type { FigureAnnotationMark } from "../../../types/annotationReference";
import {
  MARK_FONT_STACK,
  MARK_HALO_WIDTH,
  MARK_STROKE_WIDTH,
  MARK_TEXT_FONT_SIZE,
  markPathData,
  markTextBox,
} from "./render";

/** 垫在标注下面的图面层。 */
export type FigureLayer = {
  /** 已 sanitize 的 SVG 标记（内联进审阅图）。 */
  markup: string;
  /** 图自身的 viewBox（声明过才有）。 */
  viewBox?: string;
  /** 固有宽度（像素）。 */
  width: number;
  /** 固有高度（像素）。 */
  height: number;
};

/** XML 字符数据转义。 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 一条标注的 SVG 元素（带白色底衬，保证压住黑色线条仍可辨）。 */
function markSvg(mark: FigureAnnotationMark): string {
  const path = markPathData(mark);
  const font = escapeXml(MARK_FONT_STACK);
  const parts: string[] = [];
  if (path !== undefined) {
    parts.push(
      `<path d="${path}" fill="none" stroke="#ffffff" stroke-width="${MARK_HALO_WIDTH}"` +
        ' stroke-linecap="round" stroke-linejoin="round"/>',
      `<path d="${path}" fill="none" stroke="${mark.color}" stroke-width="${MARK_STROKE_WIDTH}"` +
        ' stroke-linecap="round" stroke-linejoin="round"/>',
    );
  }
  const box = markTextBox(mark);
  if (box !== undefined) {
    parts.push(
      `<rect x="${box.x - 4}" y="${box.y - MARK_TEXT_FONT_SIZE}" width="${box.width}" height="${box.height}"` +
        ` rx="3" fill="#ffffff" stroke="${mark.color}" stroke-width="1"/>`,
      `<text x="${box.x}" y="${box.y}" font-family="${font}" font-size="${MARK_TEXT_FONT_SIZE}"` +
        ` fill="${mark.color}">${escapeXml(box.text)}</text>`,
    );
  }
  return parts.join("");
}

/** 图面层作为 SVG 元素（去掉原文档外壳后内联，保留自己的 viewBox）。 */
function figureSvg(layer: FigureLayer): string {
  const viewBox = layer.viewBox === undefined ? "" : ` viewBox="${layer.viewBox}"`;
  const inner = layer.markup
    .replace(/^<\?xml[^>]*\?>\s*/u, "")
    .replace(/^<svg[^>]*>/iu, "")
    .replace(/<\/svg>\s*$/iu, "");
  return (
    `<svg x="0" y="0" width="${layer.width}" height="${layer.height}"${viewBox}` +
    ` preserveAspectRatio="xMidYMid meet">${inner}</svg>`
  );
}

/**
 * 字节编码成 data URL。
 *
 * 导出路径必须用它而不是 blob URL：SVG 装进 `<img>` 时无法解析 `blob:` 引用，
 * 用 blob URL 会让整张审阅图无法解码。
 */
export function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

/** 组装独立的审阅 SVG。 */
export function composeReviewSvg(layer: FigureLayer, marks: readonly FigureAnnotationMark[]): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ` width="${layer.width}" height="${layer.height}" viewBox="0 0 ${layer.width} ${layer.height}">` +
    `<rect x="0" y="0" width="${layer.width}" height="${layer.height}" fill="#ffffff"/>` +
    figureSvg(layer) +
    marks.map(markSvg).join("") +
    "</svg>"
  );
}

/**
 * 把审阅 SVG 光栅化成 PNG。
 *
 * @param svg - 独立 SVG 标记。
 * @param width - 输出宽度（图面像素）。
 * @param height - 输出高度（图面像素）。
 * @param scale - 输出倍率（2 倍便于模型看清细线）。
 * @throws {Error} SVG 无法解码或画布不可用时。
 */
export async function rasterizePng(svg: string, width: number, height: number, scale: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        resolve();
      };
      image.onerror = () => {
        reject(new Error("the composed review image could not be decoded"));
      };
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("a 2D canvas is unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, "image/png");
    });
    if (blob === null) throw new Error("the review image could not be encoded as PNG");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Blob 转 data URL（走 FileReader，避免 base64 手工拼接的大字符串）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("blob could not be read"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("blob could not be read"));
    };
    reader.readAsDataURL(blob);
  });
}

/** 图的内容哈希（十六进制）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("this browser cannot hash the figure (Web Crypto unavailable)");
  // 复制进新的 ArrayBuffer 后备数组：`digest` 只接受 ArrayBuffer 视图。
  const digest = await subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
