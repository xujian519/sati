/**
 * src/patent/figure — 附图图片预处理。
 *
 * 读取工作区内的附图文件，校验格式并压缩到模型可接受的大小。
 * 压缩策略参考 readFile 的多级级联（1600px/q80 → 1200px/q55 → 800px/q40），
 * 保持标号可读性的同时控制 token 成本。压缩失败时回退原始字节。
 */

import { readFile } from "node:fs/promises";
import { FIGURE_IMAGE_MIME_TYPES } from "./mime.js";

/** 附图最大字节预算（与 AttachmentResolver 图片上限一致：5 MiB）。 */
export const DEFAULT_MAX_FIGURE_BYTES = 5_242_880;

export type PreparedFigure = {
  /** 图像字节（可能已压缩）。 */
  buffer: Buffer;
  /** 图像 MIME 类型（压缩后可能变为 image/jpeg）。 */
  mimeType: string;
  /** 字节数。 */
  bytes: number;
};

async function detectMimeType(buffer: Buffer): Promise<string | null> {
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const meta = await sharp(buffer).metadata();
    const format = meta.format;
    if (!format) return null;
    const mime = FIGURE_IMAGE_MIME_TYPES[format];
    return mime ?? null;
  } catch {
    // sharp 不可用或元数据解析失败：格式未知，返回 null 交由上层判定不支持。
    return null;
  }
}

/**
 * 压缩图片到字节预算内（sharp 动态导入，失败回退原始字节）。
 *
 * 与 readFile.ts 的 compressImageForBudget 同源（三级级联策略一致），但因 patent
 * 域不得依赖 tool 层，此处独立实现且刻意更简（统一转 JPEG，兼容性最好）。
 */
async function compressForBudget(
  buffer: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (buffer.byteLength <= maxBytes) return { buffer, mimeType };

  let output = buffer;
  let outputMimeType = mimeType;
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;

    const pass = async (width: number, quality: number): Promise<{ buffer: Buffer; mimeType: string }> => {
      const resized = await sharp(output)
        .rotate()
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      return { buffer: resized, mimeType: "image/jpeg" };
    };

    if (output.byteLength > maxBytes) ({ buffer: output, mimeType: outputMimeType } = await pass(1600, 80));
    if (output.byteLength > maxBytes) ({ buffer: output, mimeType: outputMimeType } = await pass(1200, 55));
    if (output.byteLength > maxBytes) ({ buffer: output, mimeType: outputMimeType } = await pass(800, 40));
  } catch {
    // 压缩不可用时回退原始字节
    return { buffer, mimeType };
  }
  return { buffer: output, mimeType: outputMimeType };
}

/**
 * 读取并预处理附图图片。
 *
 * @param imagePath 文件绝对路径（调用方已通过工作区沙箱校验）
 * @param maxBytes 字节预算（默认 5 MiB）
 * @throws Error 文件不存在、不可解码或压缩后仍超预算
 */
export async function loadFigureImage(
  imagePath: string,
  maxBytes: number = DEFAULT_MAX_FIGURE_BYTES,
): Promise<PreparedFigure> {
  let buffer: Buffer;
  try {
    buffer = await readFile(imagePath);
  } catch (error) {
    throw new Error(`无法读取附图文件: ${imagePath}（${error instanceof Error ? error.message : String(error)}）`);
  }

  if (buffer.byteLength === 0) {
    throw new Error(`附图文件为空: ${imagePath}`);
  }

  const mimeType = await detectMimeType(buffer);
  if (!mimeType) {
    throw new Error(`无法解码附图（不支持的图像格式或文件损坏）: ${imagePath}`);
  }

  const { buffer: finalBuffer, mimeType: finalMimeType } = await compressForBudget(buffer, mimeType, maxBytes);

  if (finalBuffer.byteLength > maxBytes) {
    throw new Error(
      `附图超过模型大小预算（压缩后仍为 ${finalBuffer.byteLength} 字节，上限 ${maxBytes}）: ${imagePath}`,
    );
  }

  return { buffer: finalBuffer, mimeType: finalMimeType, bytes: finalBuffer.byteLength };
}
