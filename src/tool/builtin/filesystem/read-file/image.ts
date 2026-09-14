import { readFile } from "node:fs/promises";
import type { SatiToolExecutionOutput } from "../../../protocol/types.js";
import { SatiToolRuntimeError } from "../../../protocol/errors.js";
import { getImageMimeType } from "../fileTypeSafety.js";
import { MAX_IMAGE_BYTES } from "./constants.js";
import type { ReadFileHandlerContext } from "./types.js";

/**
 * Validate image integrity and attempt repair if truncated/corrupted.
 * Fast path: complete JPEGs (with EOI marker and > 1KB) pass through unchanged.
 * For suspicious images, attempt re-encode via sharp which can tolerate minor truncation.
 * Throws SatiToolRuntimeError if the image is unrecoverably corrupt.
 */
async function validateAndRepairImage(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const isJpeg = mimeType === "image/jpeg";
  const hasEoi =
    isJpeg && buffer.length >= 2 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;

  if (isJpeg && hasEoi && buffer.length > 1000) {
    return { buffer, mimeType };
  }

  if (!isJpeg && buffer.length > 1000) {
    // For non-JPEG formats, do a quick decode check via sharp
    try {
      const sharpModule = await import("sharp");
      const sharp = sharpModule.default;
      await sharp(buffer).metadata();
      return { buffer, mimeType };
    } catch {
      // sharp 元数据读取失败：回退到后续修复流程，不改动原 buffer（fail-safe）。
    }
  }

  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const repaired = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    return { buffer: repaired, mimeType: "image/jpeg" };
  } catch {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `Image file appears truncated or corrupted (${buffer.length} bytes). Cannot decode.`,
    );
  }
}

async function prepareImageForModel(
  buffer: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<{ ok: true; image: { buffer: Buffer; mimeType: string } } | { ok: false; error: string }> {
  try {
    const validated = await validateAndRepairImage(buffer, mimeType);
    return { ok: true, image: await compressImageForBudget(validated.buffer, validated.mimeType, maxBytes) };
  } catch (error) {
    return { ok: false, error: formatImageDecodeError(error) };
  }
}

function formatImageDecodeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300) || "unknown image decode error";
}

/**
 * Multi-pass image compressor. We size against a single byte budget (which
 * the model's own `maxImageBytes` constraint also enforces) — there's no
 * separate "image token" cap because multimodal LLMs price images by
 * dimensions or fixed tile cost, not by base64 length. A `bytes / 6`
 * heuristic on top of that just rejects perfectly cheap images (e.g. a
 * 250 KB JPEG that the model charges ~700 tokens for).
 *
 * Cascade: pass 1 = format-appropriate 1600px / quality 80, pass 2 =
 * 1200px JPEG quality 55, pass 3 = 800px JPEG quality 40. Only after all
 * three fail to fit do we surface `result_too_large`.
 */
export async function compressImageForBudget(
  buffer: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let output = buffer;
  let outputMimeType = mimeType;
  if (output.byteLength > maxBytes) {
    try {
      const sharpModule = await import("sharp");
      const sharp = sharpModule.default;
      const pipeline = sharp(buffer).rotate();
      if (mimeType === "image/png") {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        outputMimeType = "image/png";
      } else if (mimeType === "image/webp") {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        outputMimeType = "image/webp";
      } else if (mimeType === "image/gif") {
        output = await pipeline
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        outputMimeType = "image/png";
      } else {
        output = await pipeline
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }

      if (output.byteLength > maxBytes) {
        output = await sharp(output)
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 55 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }

      if (output.byteLength > maxBytes) {
        output = await sharp(output)
          .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 40 })
          .toBuffer();
        outputMimeType = "image/jpeg";
      }
    } catch {
      // Fall back to the original bytes when image compression is unavailable.
    }
  }

  if (output.byteLength > maxBytes) {
    throw new SatiToolRuntimeError(
      "result_too_large",
      `Image content exceeds the read_file byte budget after compression attempts (${mimeType}).`,
      { mimeType: outputMimeType, bytes: output.byteLength, maxBytes },
    );
  }
  return { buffer: output, mimeType: outputMimeType };
}

/** 图片读取：按模型模态能力决定附件化，超出 byte 预算时走多级压缩。 */
export async function readImageFile({
  context,
  resolved,
  fileStat,
  markRead,
  kind,
}: ReadFileHandlerContext): Promise<SatiToolExecutionOutput> {
  const mimeType = getImageMimeType(resolved.absolutePath);
  if (!mimeType) {
    throw new SatiToolRuntimeError("invalid_tool_input", `Unsupported image type: ${resolved.relativePath}.`);
  }
  const supportsImage = context.modelMultimodal?.input?.includes("image");
  if (!supportsImage) {
    return {
      content: [
        {
          type: "text",
          text: `[Image file: ${resolved.relativePath}, ${fileStat.size} bytes, ${mimeType}. Current model does not support image input.]`,
        },
      ],
      data: { filePath: resolved.relativePath, kind, modelSupportsImage: false },
    };
  }
  const imageBuffer = await readFile(resolved.absolutePath, { signal: context.abortSignal });
  const maxImageBytes = Math.min(MAX_IMAGE_BYTES, context.modelMultimodal?.maxImageBytes ?? MAX_IMAGE_BYTES);
  const preparedImage = await prepareImageForModel(imageBuffer, mimeType, maxImageBytes);
  if (!preparedImage.ok) {
    return {
      content: [
        {
          type: "text",
          text: `[Image file: ${resolved.relativePath}, ${fileStat.size} bytes, ${mimeType}. Image decoding failed, so it was not attached as model-visible image content. Diagnostic: ${preparedImage.error}]`,
        },
      ],
      data: {
        filePath: resolved.relativePath,
        kind,
        mimeType,
        bytes: imageBuffer.byteLength,
        imageDecodeFailed: true,
        error: preparedImage.error,
      },
    };
  }
  const compressed = preparedImage.image;
  markRead(fileStat.mtimeMs);
  return {
    content: [
      {
        type: "image",
        mimeType: compressed.mimeType,
        data: compressed.buffer.toString("base64"),
        bytes: compressed.buffer.byteLength,
        detail: context.modelMultimodal?.imageDetail,
      },
    ],
    data: {
      filePath: resolved.relativePath,
      kind,
      mimeType: compressed.mimeType,
      bytes: compressed.buffer.byteLength,
      originalBytes: imageBuffer.byteLength,
    },
  };
}
