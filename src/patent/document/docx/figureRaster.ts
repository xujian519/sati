/**
 * 矢量附图栅格化：SVG → PNG（300 DPI 等效），供申请文件 docx 嵌图使用。
 *
 * 为什么需要它：附图产物是 **SVG**（矢量），而 OOXML 的图片关系只认位图——
 * `imageInfo.ts` 的文件头嗅探只覆盖 PNG/JPEG/GIF/BMP，矢量附图因此进不了申请文件。
 * 本模块按 SVG **自身的物理尺寸**（根元素 `width`/`height`，毫米优先）换算目标 DPI
 * 下的像素，再栅格化成 PNG。物理尺寸的换算复用 `figuregen/svg-viewport.ts` 的
 * `measureSvgPaperSize` / `resolveSvgViewport`（落版与复核同源，不另写一套换算）。
 *
 * 两条渲染路径（与 dsh `patent-filing/assets/engine/render_figures.py` 同思路）：
 *
 * 1. **sharp**（首选）：内建 librsvg，零外部依赖。矢量在目标分辨率下**重绘**
 *    （不是把 72dpi 的位图放大，故线宽不会糊），再精确缩放到目标像素；
 * 2. **Chrome 无头**（回退）：sharp 不可用或失败时，按 SVG 自身的 CSS 像素尺寸
 *    `--window-size` + `--force-device-scale-factor` 截图，产物同样是 PNG。
 *
 * 降级但不静默（仓库 AGENTS.md 第 11 条）：走了回退路径时返回值带
 * `degraded.reason`（谁因此漏了什么），由调用方写进告警；两条路径都不可用时抛
 * `FigureRasterError`——**不静默丢图**。
 *
 * @module src/patent/document/docx/figureRaster
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { measureSvgPaperSize, resolveSvgViewport } from "../../figuregen/svg-viewport.js";
import { findChrome } from "../pdfRenderer.js";
import { probeImage } from "./imageInfo.js";

const execFileAsync = promisify(execFile);

/** 目标 DPI：与 dsh 附图管线一致（300 DPI 等效）。 */
export const DEFAULT_FIGURE_DPI = 300;

/** 毫米/英寸。 */
const MM_PER_INCH = 25.4;

/** CSS 像素/英寸（SVG 的无单位长度与 Chrome 的窗口尺寸都按 96 dpi 计）。 */
const CSS_PX_PER_INCH = 96;

/** 单边像素上限：防止异常图幅把内存吃光（300dpi 的 A0 约 14000px，此处留余量）。 */
const MAX_EDGE_PX = 16384;

/** 栅格化结果：PNG 字节 + 像素尺寸。 */
export type RasterizedFigure = {
  /** PNG 字节。 */
  readonly bytes: Buffer;
  /** 像素宽（以成品 PNG 的文件头为准，不以目标值为准）。 */
  readonly widthPx: number;
  /** 像素高（以成品 PNG 的文件头为准，不以目标值为准）。 */
  readonly heightPx: number;
  /**
   * 走了回退路径（或产物尺寸与目标偏差过大）时的说明。
   * 降级但不静默：调用方须把它写进告警，否则「谁因此漏了什么」就丢了。
   */
  readonly degraded?: { readonly reason: string };
};

/** 栅格化失败（结构化错误：调用方据此说明「这张图为什么没进申请文件」）。 */
export class FigureRasterError extends Error {
  /** 失败原因（人读一句话）。 */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "FigureRasterError";
    this.reason = reason;
  }
}

/** 渲染上下文（交给具体后端）。 */
export type FigureRasterRenderContext = {
  /** SVG 全文。 */
  readonly svgText: string;
  /** SVG 文件路径；Chrome 需要真实文件（内存里的 SVG 无路径，无法用 file:// 加载）。 */
  readonly svgPath?: string;
  /** 目标像素宽。 */
  readonly widthPx: number;
  /** 目标像素高。 */
  readonly heightPx: number;
  /** 目标 DPI。 */
  readonly dpi: number;
};

/** 栅格化后端（sharp / Chrome）。 */
export type FigureRasterBackend = {
  /** 后端名（写进降级原因，便于追溯是谁渲染的）。 */
  readonly name: string;
  /** 渲染 SVG → PNG 字节；失败抛错，由调用方决定是否回退。 */
  render(context: FigureRasterRenderContext): Promise<Buffer>;
};

/** 栅格化选项。 */
export type FigureRasterOptions = {
  /** 目标 DPI（默认 300）。 */
  readonly dpi?: number;
  /**
   * 后端链（默认 sharp → Chrome）。
   * 注入点：测试用它验证「前一条路失败 → 回退 → 降级标记」这条链路，
   * 不必真的把 sharp 或 Chrome 弄坏。
   */
  readonly backends?: readonly FigureRasterBackend[];
};

/** 目标像素尺寸（按 SVG 自身物理尺寸 × DPI 换算）。 */
export type FigurePixelSize = {
  /** 目标像素宽。 */
  readonly widthPx: number;
  /** 目标像素高。 */
  readonly heightPx: number;
  /** 本次使用的 DPI。 */
  readonly dpi: number;
};

/**
 * SVG 的物理尺寸（毫米）：根元素声明优先，其次 viewBox 按 96dpi 用户单位兜底。
 * @param svgText - SVG 全文。
 * @returns 宽高（毫米）；无法判定时 undefined。
 */
function resolvePhysicalSizeMm(svgText: string): { widthMm: number; heightMm: number } | undefined {
  const paper = measureSvgPaperSize(svgText);
  if (paper !== undefined) return paper;
  const openTag = /<svg\b[^>]*>/i.exec(svgText)?.[0];
  if (openTag === undefined) return undefined;
  const viewport = resolveSvgViewport(openTag);
  const widthMm = viewport.viewportWidthMm;
  const heightMm = viewport.viewportHeightMm;
  if (widthMm === undefined || heightMm === undefined) return undefined;
  if (widthMm <= 0 || heightMm <= 0) return undefined;
  return { widthMm, heightMm };
}

/**
 * 解析 SVG 的物理尺寸并换算成目标 DPI 下的像素。
 *
 * 换算口径：根元素声明的 `width`/`height`（mm/cm/in/pt/px，无单位按 96dpi 像素）
 * → viewBox 按 96dpi 用户单位兜底 → 都拿不到时报错（不猜尺寸）。
 * @param svgText - SVG 全文。
 * @param dpi - 目标 DPI（默认 300）。
 * @returns 目标像素尺寸。
 */
export function resolveFigurePixelSize(svgText: string, dpi: number = DEFAULT_FIGURE_DPI): FigurePixelSize {
  const mm = resolvePhysicalSizeMm(svgText);
  if (mm === undefined) {
    throw new FigureRasterError("SVG 未声明可解析的 width/height，也没有 viewBox——无法确定物理尺寸");
  }
  const scale = dpi / MM_PER_INCH;
  const widthPx = Math.max(1, Math.round(mm.widthMm * scale));
  const heightPx = Math.max(1, Math.round(mm.heightMm * scale));
  if (widthPx > MAX_EDGE_PX || heightPx > MAX_EDGE_PX) {
    throw new FigureRasterError(
      `目标尺寸 ${widthPx}×${heightPx}px 超过单边上限 ${MAX_EDGE_PX}px（图幅异常或 DPI 过高）`,
    );
  }
  return { widthPx, heightPx, dpi };
}

/**
 * sharp 后端：内建 librsvg，矢量在目标分辨率下重绘。
 *
 * 两步走：① 按不低于目标的密度渲染（矢量重绘，不是放大位图，线宽不糊）；
 * ② 精确缩放到目标像素，抹平密度换算的取整误差（纵横比与目标一致，只差舍入）。
 */
export const sharpFigureRasterBackend: FigureRasterBackend = {
  name: "sharp",
  async render(context: FigureRasterRenderContext): Promise<Buffer> {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const source = Buffer.from(context.svgText, "utf8");
    let density = context.dpi;
    let rendered = await sharp(source, { density }).png().toBuffer();
    let meta = await sharp(rendered).metadata();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width >= context.widthPx && height >= context.heightPx) break;
      const ratio = Math.max(context.widthPx / Math.max(width, 1), context.heightPx / Math.max(height, 1));
      density = density * Math.max(1.5, ratio);
      rendered = await sharp(source, { density }).png().toBuffer();
      meta = await sharp(rendered).metadata();
    }
    return sharp(rendered).resize({ width: context.widthPx, height: context.heightPx, fit: "fill" }).png().toBuffer();
  },
};

/**
 * Chrome 无头后端：按 SVG 自身的 CSS 像素尺寸截图（dsh 附图管线的同一条路径）。
 *
 * Chrome 的窗口尺寸以 CSS 像素计，故先按 `dpi / 96` 折回 CSS 像素，再用
 * `--force-device-scale-factor` 把截图放大到目标像素。截图落在临时目录，函数返回前清掉。
 */
export const chromeFigureRasterBackend: FigureRasterBackend = {
  name: "chrome",
  async render(context: FigureRasterRenderContext): Promise<Buffer> {
    const chrome = findChrome();
    if (chrome === undefined) {
      throw new FigureRasterError(
        "未找到 Chrome/Chromium 可执行文件（可安装 Chrome，或设置 SATI_CHROME_PATH 指向可执行文件）",
      );
    }
    if (context.svgPath === undefined) {
      throw new FigureRasterError("Chrome 回退需要 SVG 文件路径（内存里的 SVG 无路径，无法用 file:// 加载）");
    }
    const scale = context.dpi / CSS_PX_PER_INCH;
    const cssWidth = Math.max(1, Math.round(context.widthPx / scale));
    const cssHeight = Math.max(1, Math.round(context.heightPx / scale));
    const workDir = await mkdtemp(join(tmpdir(), "sati-figure-raster-"));
    const shotPath = join(workDir, "figure.png");
    try {
      const args = [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--default-background-color=FFFFFFFF",
        // 独立 profile：避免与用户正在运行的 Chrome 抢默认 profile（headless 会因此起不来）。
        `--user-data-dir=${join(workDir, "chrome-profile")}`,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${cssWidth},${cssHeight}`,
        `--screenshot=${shotPath}`,
        pathToFileURL(context.svgPath).href,
      ];
      await execFileAsync(chrome, args, { timeout: 120_000, cwd: dirname(chrome) || undefined });
      return await readFile(shotPath);
    } catch (err) {
      throw new FigureRasterError(`Chrome 无头截图失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
};

/** 默认后端链：sharp 优先，Chrome 兜底。 */
const DEFAULT_BACKENDS: readonly FigureRasterBackend[] = [sharpFigureRasterBackend, chromeFigureRasterBackend];

/**
 * 把 SVG 全文栅格化成 PNG。
 *
 * @param svgText - SVG 全文。
 * @param options - 目标 DPI 与后端链（后端链为测试注入点）。
 * @param options.svgPath - SVG 文件路径（Chrome 后端需要；缺省时该后端不可用）。
 * @returns PNG 字节与实测像素尺寸；走了回退路径时带 `degraded.reason`。
 */
export async function rasterizeFigureSvgText(
  svgText: string,
  options?: FigureRasterOptions & { readonly svgPath?: string },
): Promise<RasterizedFigure> {
  const dpi = options?.dpi ?? DEFAULT_FIGURE_DPI;
  const size = resolveFigurePixelSize(svgText, dpi);
  const backends = options?.backends ?? DEFAULT_BACKENDS;
  const failures: string[] = [];
  for (const backend of backends) {
    try {
      const bytes = await backend.render({
        svgText,
        ...(options?.svgPath === undefined ? {} : { svgPath: options.svgPath }),
        widthPx: size.widthPx,
        heightPx: size.heightPx,
        dpi,
      });
      const probe = probeImage(bytes);
      if (probe === undefined || probe.ext !== "png") {
        throw new FigureRasterError(`${backend.name} 的产物不是可识别的 PNG`);
      }
      const notes: string[] = [];
      if (failures.length > 0) notes.push(`已回退（${failures.join("；")}）`);
      const delta = Math.max(
        Math.abs(probe.widthPx - size.widthPx) / size.widthPx,
        Math.abs(probe.heightPx - size.heightPx) / size.heightPx,
      );
      if (delta > 0.01) {
        notes.push(
          `产物尺寸 ${probe.widthPx}×${probe.heightPx}px 与目标 ${size.widthPx}×${size.heightPx}px 偏差 ${(delta * 100).toFixed(1)}%`,
        );
      }
      return {
        bytes,
        widthPx: probe.widthPx,
        heightPx: probe.heightPx,
        ...(notes.length === 0 ? {} : { degraded: { reason: notes.join("；") } }),
      };
    } catch (err) {
      failures.push(`${backend.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new FigureRasterError(
    `矢量附图栅格化失败（已尝试 ${backends.length} 条路径）：${failures.join("；") || "无可用后端"}`,
  );
}

/**
 * 把矢量附图（SVG 文件）栅格化为 PNG。
 *
 * @param svgPath - SVG 文件路径。
 * @param options - 目标 DPI（默认 300）与后端链（测试注入点）。
 * @returns PNG 字节与实测像素尺寸；走了回退路径时带 `degraded.reason`。
 */
export async function rasterizeFigureSvg(svgPath: string, options?: FigureRasterOptions): Promise<RasterizedFigure> {
  let svgText: string;
  try {
    svgText = await readFile(svgPath, "utf8");
  } catch (err) {
    throw new FigureRasterError(`读取 SVG 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return rasterizeFigureSvgText(svgText, { ...options, svgPath });
}
