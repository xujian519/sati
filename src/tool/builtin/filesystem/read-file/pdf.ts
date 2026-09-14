import { readFile } from "node:fs/promises";
import type { SatiToolExecutionOutput } from "../../../protocol/types.js";
import { SatiToolRuntimeError } from "../../../protocol/errors.js";
import { countPdfPages, parsePdfPageRange } from "../fileTypeSafety.js";
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_PAGES_PER_REQUEST,
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
} from "./constants.js";
import { compressImageForBudget } from "./image.js";
import type { ReadFileHandlerContext } from "./types.js";

async function renderPdfPagesAsImages(
  pdfBuffer: Buffer,
  relativePath: string,
  pages: { firstPage: number; lastPage: number } | undefined,
  pageCount: number | undefined,
  maxImageBytes: number,
  imageDetail: "auto" | "low" | "high" | undefined,
): Promise<
  | {
      ok: true;
      images: Array<{
        type: "image";
        mimeType: string;
        data: string;
        bytes: number;
        detail?: "auto" | "low" | "high";
      }>;
      firstPage: number;
      lastPage: number;
      truncated: boolean;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const firstPage = pages?.firstPage ?? 1;
  const lastPage = pages?.lastPage ?? Math.min(pageCount ?? MAX_PDF_PAGES_PER_REQUEST, MAX_PDF_PAGES_PER_REQUEST);
  const truncated = pages === undefined && pageCount !== undefined && pageCount > lastPage;

  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");

    const images = [];
    for (let i = firstPage - 1; i < lastPage; i++) {
      const page = doc.loadPage(i);
      const scale = 100 / 72;
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      const jpegData = pixmap.asJPEG(80, false);
      const jpegBuffer = Buffer.from(jpegData);

      const compressed = await compressImageForBudget(
        jpegBuffer,
        "image/jpeg",
        Math.min(MAX_IMAGE_BYTES, maxImageBytes),
      );
      images.push({
        type: "image" as const,
        mimeType: compressed.mimeType,
        data: compressed.buffer.toString("base64"),
        bytes: compressed.buffer.byteLength,
        ...(imageDetail ? { detail: imageDetail } : {}),
      });
    }

    if (images.length === 0) {
      return { ok: false, error: `mupdf produced no page images for ${relativePath}` };
    }

    return {
      ok: true,
      images,
      firstPage,
      lastPage,
      truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message || "mupdf rendering failed" };
  }
}

/**
 * PDF 读取：指定 pages 时渲染为图片；未指定时按页数阈值拒绝整读，
 * 模型不支持 PDF 或文件超大时降级为首页若干页的图片渲染。
 */
export async function readPdfFile({
  input,
  context,
  resolved,
  fileStat,
  markRead,
  kind,
}: ReadFileHandlerContext): Promise<SatiToolExecutionOutput> {
  const supportsPdf = context.modelMultimodal?.input?.includes("pdf");
  const supportsImage = context.modelMultimodal?.input?.includes("image");
  const parsedPages = input.pages ? parsePdfPageRange(input.pages) : undefined;
  if (input.pages && !parsedPages) {
    throw new SatiToolRuntimeError("invalid_tool_input", `Invalid PDF page range: ${input.pages}.`);
  }

  const pdfBuffer = await readFile(resolved.absolutePath, { signal: context.abortSignal });
  const pageCount = await countPdfPages(pdfBuffer);

  if (parsedPages && pageCount !== undefined && parsedPages.lastPage > pageCount) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `PDF page range ${input.pages} exceeds the detected page count (${pageCount}).`,
    );
  }

  // With pages parameter: always render as images via mupdf
  if (parsedPages) {
    if (!supportsImage) {
      return {
        content: [
          {
            type: "text",
            text: `[PDF file: ${resolved.relativePath}, ${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""}. Current model does not support image input; cannot render requested pages.]`,
          },
        ],
        data: { filePath: resolved.relativePath, kind, modelSupportsImage: false, pageCount },
      };
    }
    const rendered = await renderPdfPagesAsImages(
      pdfBuffer,
      resolved.relativePath,
      parsedPages,
      pageCount,
      context.modelMultimodal?.maxImageBytes ?? MAX_IMAGE_BYTES,
      context.modelMultimodal?.imageDetail,
    );
    if (!rendered.ok) {
      return {
        content: [
          {
            type: "text",
            text: `[PDF file: ${resolved.relativePath}. PDF page rendering failed: ${rendered.error}]`,
          },
        ],
        data: { filePath: resolved.relativePath, kind, pageCount, renderError: rendered.error },
      };
    }
    markRead(fileStat.mtimeMs);
    return {
      content: [
        {
          type: "text" as const,
          text: `PDF pages extracted: ${rendered.lastPage - rendered.firstPage + 1} page(s) from ${resolved.relativePath} (pages ${rendered.firstPage}-${rendered.lastPage}${pageCount ? ` of ${pageCount}` : ""}).`,
        },
      ],
      supplementalMessages: [
        {
          role: "user",
          content: rendered.images,
          isMeta: true,
        },
      ],
      data: {
        filePath: resolved.relativePath,
        kind,
        pdfPagesRendered: true,
        pageCount,
        requestedPages: input.pages,
        renderedPages: { firstPage: rendered.firstPage, lastPage: rendered.lastPage },
        truncated: rendered.truncated,
      },
      metadata: { truncated: rendered.truncated },
    };
  }

  // Without pages: enforce page count threshold
  if (pageCount !== undefined && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `This PDF has ${pageCount} pages, which is too many to read at once. ` +
        `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
        `Maximum ${MAX_PDF_PAGES_PER_REQUEST} pages per request.`,
    );
  }

  // Degrade to image rendering when model lacks PDF support or file is large
  if (!supportsPdf || fileStat.size > PDF_EXTRACT_SIZE_THRESHOLD) {
    if (!supportsImage) {
      return {
        content: [
          {
            type: "text",
            text: `[PDF file: ${resolved.relativePath}, ${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""}. Current model does not support PDF input or image input.]`,
          },
        ],
        data: {
          filePath: resolved.relativePath,
          kind,
          modelSupportsPdf: false,
          modelSupportsImage: false,
          pageCount,
        },
      };
    }
    const rendered = await renderPdfPagesAsImages(
      pdfBuffer,
      resolved.relativePath,
      undefined,
      pageCount,
      context.modelMultimodal?.maxImageBytes ?? MAX_IMAGE_BYTES,
      context.modelMultimodal?.imageDetail,
    );
    if (rendered.ok) {
      markRead(fileStat.mtimeMs);
      const degradeReason = !supportsPdf
        ? "model does not support PDF input"
        : `file exceeds ${PDF_EXTRACT_SIZE_THRESHOLD / 1024 / 1024}MB threshold`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `[PDF pages rendered from ${resolved.relativePath}: ${rendered.firstPage}-${rendered.lastPage}${pageCount ? ` of ${pageCount}` : ""} (${degradeReason}).]` +
              (rendered.truncated
                ? `\n[PDF truncated to ${MAX_PDF_PAGES_PER_REQUEST} pages; use the pages parameter to read another range.]`
                : ""),
          },
        ],
        supplementalMessages: [
          {
            role: "user",
            content: rendered.images,
            isMeta: true,
          },
        ],
        data: {
          filePath: resolved.relativePath,
          kind,
          modelSupportsPdf: !!supportsPdf,
          pdfPagesRendered: true,
          degradeReason,
          pageCount,
          renderedPages: { firstPage: rendered.firstPage, lastPage: rendered.lastPage },
          truncated: rendered.truncated,
        },
        metadata: { truncated: rendered.truncated },
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `[PDF file: ${resolved.relativePath}, ${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""}. PDF page rendering failed: ${rendered.error}]`,
        },
      ],
      data: {
        filePath: resolved.relativePath,
        kind,
        modelSupportsPdf: !!supportsPdf,
        pageCount,
        renderError: rendered.error,
      },
    };
  }

  // Model supports PDF and file is small enough: send as document block
  markRead(fileStat.mtimeMs);
  return {
    content: [
      {
        type: "text" as const,
        text: `PDF file read: ${resolved.relativePath} (${fileStat.size} bytes${pageCount ? `, ${pageCount} pages` : ""})`,
      },
    ],
    supplementalMessages: [
      {
        role: "user",
        content: [
          {
            type: "pdf" as const,
            mimeType: "application/pdf" as const,
            data: pdfBuffer.toString("base64"),
            bytes: pdfBuffer.byteLength,
            pages: pageCount,
          },
        ],
        isMeta: true,
      },
    ],
    data: {
      filePath: resolved.relativePath,
      kind,
      bytes: pdfBuffer.byteLength,
      pageCount,
    },
  };
}
