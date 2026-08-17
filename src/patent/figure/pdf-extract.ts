/**
 * 专利 PDF 附图提取（P2-2）。
 *
 * 使用 mupdf 将 PDF 页面高质量渲染为 PNG，并提取页面文本及坐标，
 * 作为 analyze_patent_figure 的输入；同时提供启发式候选附图页识别。
 *
 * 注意：本层不做完整矢量路径解析（需专用 CAD/PDF 矢量化库），
 * 而是利用 PDF 矢量渲染无失真的优势，把页面转成高分辨率位图后
 * 复用现有 VLM 两步法识别电路图。文本坐标用于后续图文对齐。
 */

import { readFile } from "node:fs/promises";
import * as mupdf from "mupdf";

export type PdfExtractOptions = {
  /** 指定页码（1-based）；缺省全部页面。 */
  pageNumbers?: number[];
  /** 渲染 DPI（默认 200，电路图建议 ≥200）。 */
  dpi?: number;
  /** 颜色空间（默认 "RGB"）。 */
  colorspace?: "RGB" | "Gray";
  /** 最大页数限制（避免大文件过载）。 */
  maxPages?: number;
};

export type PdfTextBlock = {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
};

export type PdfExtractedPage = {
  /** 1-based 页码。 */
  pageNumber: number;
  width: number;
  height: number;
  imageBase64: string;
  imageMimeType: "image/png";
  textBlocks: PdfTextBlock[];
};

export type PdfFigureCandidate = PdfExtractedPage & {
  /** 附图候选得分（越高越可能是附图页）。 */
  score: number;
  /** 触发附图判定的理由。 */
  reasons: string[];
};

const DEFAULT_DPI = 200;
const MAX_PAGES_DEFAULT = 100;

/**
 * 打开 PDF 文档（文件路径或 Buffer）。
 */
export function openPdfDocument(source: string | Buffer | Uint8Array): mupdf.Document {
  if (typeof source === "string") {
    return mupdf.Document.openDocument(source, "application/pdf");
  }
  return mupdf.Document.openDocument(source, "application/pdf");
}

/**
 * 渲染 PDF 指定页面为 PNG base64，并提取文本块。
 */
export function extractPdfPages(
  source: string | Buffer | Uint8Array,
  opts: PdfExtractOptions = {},
): PdfExtractedPage[] {
  const doc = openPdfDocument(source);
  try {
    const totalPages = doc.countPages();
    const pageNumbers = resolvePageNumbers(opts.pageNumbers, totalPages, opts.maxPages ?? MAX_PAGES_DEFAULT);
    const dpi = opts.dpi ?? DEFAULT_DPI;
    const scale = dpi / 72;
    const colorSpace = opts.colorspace === "Gray" ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;

    return pageNumbers.map(pageNumber => {
      const page = doc.loadPage(pageNumber - 1);
      try {
        const bounds = page.getBounds();
        const width = (bounds[2] - bounds[0]) * scale;
        const height = (bounds[3] - bounds[1]) * scale;
        const matrix = mupdf.Matrix.scale(scale, scale);
        const pixmap = page.toPixmap(matrix, colorSpace);
        try {
          const pngBuffer = pixmap.asPNG();
          const imageBase64 = Buffer.from(pngBuffer).toString("base64");
          const textBlocks = extractPageTextBlocks(page);
          return {
            pageNumber,
            width,
            height,
            imageBase64,
            imageMimeType: "image/png" as const,
            textBlocks,
          };
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    });
  } finally {
    doc.destroy();
  }
}

/**
 * 提取候选附图页。
 *
 * 启发式：
 * 1. 页面文本包含“图N”、“FIGURE N”、“附图”等标记；
 * 2. 图形密度启发：文本块数量适中（附图通常文字较少、线条多，
 *    但 mupdf 文本提取无法直接统计线条；这里用“非空且字数不过多”近似）。
 */
export function extractPdfFigureCandidates(
  source: string | Buffer | Uint8Array,
  opts: PdfExtractOptions = {},
): PdfFigureCandidate[] {
  const pages = extractPdfPages(source, opts);
  return pages.map(page => scoreFigureCandidate(page));
}

function resolvePageNumbers(requested: number[] | undefined, totalPages: number, maxPages: number): number[] {
  if (!requested || requested.length === 0) {
    const count = Math.min(totalPages, maxPages);
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const valid = requested.filter(n => n >= 1 && n <= totalPages);
  return valid.slice(0, maxPages);
}

function extractPageTextBlocks(page: mupdf.Page): PdfTextBlock[] {
  const structured = page.toStructuredText();
  try {
    const raw = JSON.parse(structured.asJSON()) as {
      blocks?: {
        bbox?: mupdf.Rect;
        lines?: {
          bbox?: mupdf.Rect;
          text?: string;
          chars?: { c?: string }[];
        }[];
      }[];
    };
    const blocks: PdfTextBlock[] = [];
    for (const block of raw.blocks ?? []) {
      for (const line of block.lines ?? []) {
        const text = typeof line.text === "string" ? line.text : (line.chars ?? []).map(c => c.c ?? "").join("");
        if (!text.trim()) continue;
        const bbox = line.bbox ?? block.bbox ?? [0, 0, 0, 0];
        blocks.push({
          text: text.trim(),
          bbox: {
            x: Number(bbox[0]) || 0,
            y: Number(bbox[1]) || 0,
            w: (Number(bbox[2]) || 0) - (Number(bbox[0]) || 0),
            h: (Number(bbox[3]) || 0) - (Number(bbox[1]) || 0),
          },
        });
      }
    }
    return blocks;
  } finally {
    structured.destroy();
  }
}

function scoreFigureCandidate(page: PdfExtractedPage): PdfFigureCandidate {
  const reasons: string[] = [];
  let score = 0;

  const fullText = page.textBlocks.map(b => b.text).join("");

  // 附图关键词
  if (/图\s*\d+/u.test(fullText)) {
    score += 2;
    reasons.push("含“图N”标记");
  }
  if (/FIGURE\s*\d+/iu.test(fullText)) {
    score += 2;
    reasons.push("含 FIGURE N 标记");
  }
  if (/附图/u.test(fullText)) {
    score += 1;
    reasons.push("含“附图”字样");
  }

  // 附图页通常文字块少、每块字数少
  const avgLen = page.textBlocks.length > 0 ? fullText.length / page.textBlocks.length : 0;
  if (page.textBlocks.length > 0 && avgLen < 15) {
    score += 1;
    reasons.push("文字块短，疑为图注");
  }

  // 专利说明书正文页通常有大量文本；附图页文字少
  if (fullText.length > 0 && fullText.length < 500) {
    score += 1;
    reasons.push("页面总字数少，疑为附图");
  }

  return { ...page, score, reasons };
}

/**
 * 从 PDF Buffer/文件路径读取并返回 base64 PNG 图片（便捷函数）。
 */
export function renderPdfPageAsBase64(
  source: string | Buffer | Uint8Array,
  pageNumber: number,
  opts?: Omit<PdfExtractOptions, "pageNumbers">,
): { base64: string; mimeType: "image/png"; width: number; height: number } {
  const pages = extractPdfPages(source, { ...opts, pageNumbers: [pageNumber] });
  const page = pages[0];
  if (!page) throw new Error(`PDF 第 ${pageNumber} 页渲染失败或页码越界`);
  return { base64: page.imageBase64, mimeType: page.imageMimeType, width: page.width, height: page.height };
}

/**
 * 读取文件并提取 PDF 页面（便捷函数）。异步读文件（fs/promises），
 * 避免工具执行路径上的同步 I/O 阻塞事件循环。
 */
export async function extractPdfPagesFromFile(filePath: string, opts?: PdfExtractOptions): Promise<PdfExtractedPage[]> {
  const buffer = await readFile(filePath);
  return extractPdfPages(buffer, opts);
}
