/**
 * 合成"审阅图"——原图 + 全部标注，作为一张独立 SVG 光栅化成 PNG。
 *
 * 独立的意思是：不引用任何外部资源、只用系统字体，这样送进 `<img>` 解码不会因跨域或
 * 字体缺失而失败；智能体收到的就是用户确认过的那张图。
 */
import type { AnnotationMark, AnnotationHashAlgo } from "../../../types/annotationReference";
import {
  MARK_FONT_STACK,
  MARK_HALO_WIDTH,
  MARK_STROKE_WIDTH,
  MARK_TEXT_FONT_SIZE,
  markPathData,
  markTextBox,
} from "./render";

/** 垫在标注下面的图面层。 */
export type AnnotationLayer = {
  /**
   * 已 sanitize 的根元素标记，作为嵌套 `<svg>` 原样嵌入审阅图。
   *
   * **不能剥根标签**：`xmlns:*` 前缀声明长在根标签上，剥掉就会留下未绑定的前缀
   * （Inkscape/CAD 导出的 `inkscape:label`、`sodipodi:*` 很常见），整张审阅图解码失败。
   */
  markup: string;
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
function markSvg(mark: AnnotationMark): string {
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

/** 组装独立的审阅 SVG。 */
export function composeReviewSvg(layer: AnnotationLayer, marks: readonly AnnotationMark[]): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ` width="${layer.width}" height="${layer.height}" viewBox="0 0 ${layer.width} ${layer.height}">` +
    `<rect x="0" y="0" width="${layer.width}" height="${layer.height}" fill="#ffffff"/>` +
    // 图面层原样嵌入成嵌套 `<svg>`（宽度、高度与 viewBox 都在它自己身上）。
    layer.markup +
    marks.map(markSvg).join("") +
    "</svg>"
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

/** 栅格图片扩展名 → 媒体类型（blob 未带 type 时按文件名补齐）。 */
const RASTER_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
};

/**
 * 栅格图的媒体类型。
 *
 * 优先用 blob 自带的 type；缺失或不是 `image/*` 时按扩展名补——data URL 上的类型错了，
 * 审阅图里的 `<image>` 可能整条解码不出来。
 */
export function rasterMediaType(blobType: string, fileName: string): string {
  if (blobType.startsWith("image/")) return blobType;
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  return RASTER_MEDIA_TYPES[extension] ?? "image/png";
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

/** 图内容哈希：算法与十六进制摘要（一起比较才能判定"是不是同一版图"）。 */
export type AnnotationContentHash = {
  algo: AnnotationHashAlgo;
  hex: string;
};

/** FNV-1a 64 的参数（64 位）。 */
const FNV1A64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A64_PRIME = 0x100000001b3n;
const FNV1A64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64 位指纹（十六进制，恒 16 位）。
 *
 * **不是密码学哈希**：它只回答"这份字节与上次是不是同一份"，用在没有 `crypto.subtle`
 * 的非安全上下文里，避免整个标注面板因取哈希失败而不可用。已知向量（`""` → `cbf29ce484222325`、
 * `"a"` → `af63dc4c8601ec8c`、`"foobar"` → `85944171f73967e8`）见 `export.spec.ts`。
 */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let hash = FNV1A64_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV1A64_PRIME) & FNV1A64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * 图的内容哈希（算法 + 十六进制摘要）。
 *
 * 优先用 `crypto.subtle` 的 SHA-256；它只存在于安全上下文（https / localhost / 127.0.0.1），
 * 局域网 http 访问下退化为 {@link fnv1a64Hex}。两条路径都会成功返回——取哈希是图面就绪的
 * 前提，抛错会让整块面板进入错误态（连不需要哈希的"仅保存"也一并不可用）。
 */
export async function annotationContentHash(bytes: Uint8Array): Promise<AnnotationContentHash> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return { algo: "fnv1a64", hex: fnv1a64Hex(bytes) };
  // 复制进新的 ArrayBuffer 后备数组：`digest` 只接受 ArrayBuffer 视图。
  const digest = await subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return { algo: "sha256", hex: hexOf(new Uint8Array(digest)) };
}

/** 字节序列的十六进制表示。 */
function hexOf(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
