/**
 * src/patent/figuregen — 栅格附图像素级门禁（客户扫描件 / CAD 导出 / 他人绘制的图）。
 *
 * 为什么需要：本模块的 V 规则吃 FigureSpec 或本渲染器产出的 SVG，`readback.ts` 明确
 * "外部工具产出的 SVG 不在此契约内" ⇒ 栅格/外部来源的附图此前**零确定性门禁**（只能靠
 * 肉眼看）。本项目已依赖 sharp（`figure/preprocess.ts`），补齐成本低。
 *
 * 判定项（规则号 `PX*` 与 CNIPA 规则号 `V*` 分列：这不是"细则某条"，是交付图像的
 * 可判质量属性）：
 * - **PX1 黑白性**：中间灰占比过高（阴影/着色/灰度渲染代理）——指南一部一章 4.3/4.6
 *   要求黑白线条；两级判定：占比 > 30% 判 fail，> 5% 判 warn（扫描件的边缘抗锯齿会
 *   产生少量灰，单级硬判会误伤）。
 * - **PX2 线宽**：非白像素 run-length 的 5% 分位（对孤立噪点稳健）换算打印毫米，
 *   再按"缩到 2/3"折算；低于最小可辨线宽判 warn（同指南 4.3 的缩小可辨要求）。
 * - **PX3 尺寸/DPI**：DPI 落在可用区间之外、或纸面尺寸超出 A4 可印区（需缩放，
 *   缩放后线宽/字高同比例下降）判 warn。
 * - **PX4 图号声明**：栅格侧**不做 OCR**——图号存在性无法从像素判定，故只核验
 *   "调用方是否声明了图号"（文件名 `…-fig3.png` / `…图3…`）：未声明判 warn（诚实降级，
 *   不假装能读像素），已声明则给出 info 说明仍需人工确认。
 *
 * 纯函数（`analyzeGrayImage`）与 I/O 包装（`analyzeImageFile`）分离：纯函数可直接用
 * 构造的灰度缓冲测试，无需二进制 fixture。
 */

import { PRINTABLE_HEIGHT_MM, PRINTABLE_WIDTH_MM, pxToMm } from "./page-contract.js";
import type { FigureCheckSeverity } from "./check.js";

/** 规则号（`PX*` 与 CNIPA 的 `V*` 分列，见模块注释）。 */
export type PixelRuleId = "PX1" | "PX2" | "PX3" | "PX4";

export type PixelFinding = {
  rule: PixelRuleId;
  severity: FigureCheckSeverity;
  message: string;
  evidence?: string[];
};

/** 判据常量（评分线/阈值只在此处与 HITL 报告面出现，不进工具描述）。 */
export const PIXEL_MID_GRAY_FAIL_RATIO = 0.3;
export const PIXEL_MID_GRAY_WARN_RATIO = 0.05;
/** 中间灰判定区间（既非墨线也非纸白）：0-255 灰度。 */
export const PIXEL_INK_MAX = 160;
export const PIXEL_WHITE_MIN = 245;
export const PIXEL_MID_GRAY_RANGE: readonly [number, number] = [50, 205];
/** 最小可辨线宽（打印后毫米）与三分之二折算。 */
export const MIN_PRINTED_LINE_MM = 0.1;
export const PIXEL_LEGIBILITY_SHRINK_FACTOR = 2 / 3;
/** 可用 DPI 区间（低于下限栅格化不足、高于上限多为上游误标）。 */
export const PIXEL_MIN_DPI = 72;
export const PIXEL_MAX_DPI = 300;
/** 线宽统计所需最少 run 数（墨迹太少时不做线宽判定——诚实降级）。 */
export const PIXEL_MIN_RUNS = 20;
/** 像素分析上限（超出则跳过并说明：解码 + 逐像素扫描的成本远超收益）。 */
export const PIXEL_MAX_ANALYZE_PIXELS = 25_000_000;

/** 单通道灰度图（`data.length === width * height`）。 */
export type GrayImage = {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
};

export type PixelGateOptions = {
  /** 图像来源名（文件名，用于图号声明与报告）。 */
  name?: string;
  /** 显式声明的图号（优先于文件名推断）。 */
  figureNo?: number;
  /** DPI 元数据（缺省按 96 估算并在证据里注明）。 */
  dpi?: number;
};

export type PixelMetrics = {
  width: number;
  height: number;
  /** 使用的 DPI（元数据缺失时为估算值，见 dpiEstimated）。 */
  dpi: number;
  dpiEstimated: boolean;
  /** 非白像素占比。 */
  inkRatio: number;
  /** 中间灰像素占比（非白像素中既非墨线也非纸白的部分）。 */
  midGrayRatio: number;
  /** 非白 run-length 的 5% 分位（px）；样本不足时为 undefined。 */
  linePx?: number;
  /** 非白 run-length 的中位数（px）；样本不足时为 undefined。 */
  medianLinePx?: number;
  printedWidthMm?: number;
  printedHeightMm?: number;
  /** 打印线宽（mm）与再缩 2/3 后线宽（mm）；样本不足时为 undefined。 */
  printedLineMm?: number;
  printedLineShrunkMm?: number;
  /** 从文件名或显式参数得到的图号声明。 */
  declaredFigureNo?: number;
};

export type PixelGateResult = {
  metrics: PixelMetrics;
  findings: PixelFinding[];
};

/** 从文件名推断图号声明（`…-fig3.png` / `…_fig3.png` / `…图3.png`）；无则 undefined。 */
export function declaredFigureNoFromName(name: string): number | undefined {
  const match = /(?:^|[^\d])(?:fig|figure|图)\s*[-_]?\s*(\d{1,3})(?!\d)/iu.exec(name);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/** 非白像素 run-length 样本（行 + 列扫描；白 = >= PIXEL_WHITE_MIN）。 */
function collectRuns(image: GrayImage): number[] {
  const runs: number[] = [];
  const { width, height, data } = image;
  const scan = (length: number, at: (index: number) => number) => {
    let run = 0;
    for (let index = 0; index < length; index += 1) {
      if (at(index) < PIXEL_WHITE_MIN) {
        run += 1;
        continue;
      }
      if (run > 0) runs.push(run);
      run = 0;
    }
    if (run > 0) runs.push(run);
  };
  for (let y = 0; y < height; y += 1) {
    scan(width, x => data[y * width + x] ?? 0);
  }
  for (let x = 0; x < width; x += 1) {
    scan(height, y => data[y * width + x] ?? 0);
  }
  return runs;
}

function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

/**
 * 灰度图 → 指标 + 像素级发现（纯函数，无 I/O；测试可直接构造缓冲区）。
 */
export function analyzeGrayImage(image: GrayImage, options: PixelGateOptions = {}): PixelGateResult {
  const total = image.width * image.height;
  const dpiEstimated = options.dpi === undefined || options.dpi <= 0;
  const dpi = dpiEstimated ? 96 : options.dpi!;
  const declaredFigureNo = options.figureNo ?? declaredFigureNoFromName(options.name ?? "");

  const metrics: PixelMetrics = {
    width: image.width,
    height: image.height,
    dpi,
    dpiEstimated,
    inkRatio: 0,
    midGrayRatio: 0,
    ...(declaredFigureNo === undefined ? {} : { declaredFigureNo }),
  };
  const findings: PixelFinding[] = [];

  if (total === 0) {
    findings.push({ rule: "PX1", severity: "warn", message: "图像无像素（尺寸为 0），无法做像素级核查" });
    return { metrics, findings };
  }
  if (total > PIXEL_MAX_ANALYZE_PIXELS) {
    findings.push({
      rule: "PX3",
      severity: "info",
      message: `图像 ${image.width}×${image.height} 像素超过逐像素分析上限（${PIXEL_MAX_ANALYZE_PIXELS}），跳过像素级核查`,
    });
    return { metrics, findings };
  }

  let ink = 0;
  let midGray = 0;
  for (let i = 0; i < total; i += 1) {
    const value = image.data[i] ?? 0;
    if (value >= PIXEL_WHITE_MIN) continue;
    ink += 1;
    if (value >= PIXEL_MID_GRAY_RANGE[0] && value <= PIXEL_MID_GRAY_RANGE[1]) midGray += 1;
  }
  metrics.inkRatio = ratio(ink, total);
  metrics.midGrayRatio = ratio(midGray, ink);

  // PX1 黑白性
  if (metrics.midGrayRatio > PIXEL_MID_GRAY_FAIL_RATIO) {
    findings.push({
      rule: "PX1",
      severity: "fail",
      message: `图像含大面积中间灰（占非白像素 ${(metrics.midGrayRatio * 100).toFixed(1)}%），疑似灰度/着色渲染（指南一部一章 4.3/4.6：附图应为黑白线条）`,
      evidence: [
        `非白像素占比 ${(metrics.inkRatio * 100).toFixed(2)}%，中间灰区间 ${PIXEL_MID_GRAY_RANGE[0]}-${PIXEL_MID_GRAY_RANGE[1]}`,
      ],
    });
  } else if (metrics.midGrayRatio > PIXEL_MID_GRAY_WARN_RATIO) {
    findings.push({
      rule: "PX1",
      severity: "warn",
      message: `图像含中间灰像素（占非白像素 ${(metrics.midGrayRatio * 100).toFixed(1)}%），可能是扫描灰度/抗锯齿或着色元素，请人工确认是否黑白线条`,
      evidence: [
        `中间灰区间 ${PIXEL_MID_GRAY_RANGE[0]}-${PIXEL_MID_GRAY_RANGE[1]}；阈值 warn>${PIXEL_MID_GRAY_WARN_RATIO}，fail>${PIXEL_MID_GRAY_FAIL_RATIO}`,
      ],
    });
  }

  // PX2 线宽（run-length 5% 分位；样本不足则跳过）
  const runs = collectRuns(image).sort((a, b) => a - b);
  if (runs.length >= PIXEL_MIN_RUNS) {
    const linePx = percentile(runs, 0.05)!;
    const medianLinePx = percentile(runs, 0.5)!;
    const printedLineMm = (linePx / dpi) * 25.4;
    metrics.linePx = linePx;
    metrics.medianLinePx = medianLinePx;
    metrics.printedLineMm = printedLineMm;
    metrics.printedLineShrunkMm = printedLineMm * PIXEL_LEGIBILITY_SHRINK_FACTOR;
    if (metrics.printedLineShrunkMm < MIN_PRINTED_LINE_MM) {
      findings.push({
        rule: "PX2",
        severity: "warn",
        message: `最细线宽约 ${linePx}px（打印约 ${printedLineMm.toFixed(3)}mm，缩 2/3 后约 ${metrics.printedLineShrunkMm.toFixed(3)}mm）低于最小可辨线宽 ${MIN_PRINTED_LINE_MM}mm`,
        evidence: [
          `DPI ${dpi}${dpiEstimated ? "（元数据缺失，按 96 估算）" : ""}；线宽中位数 ${medianLinePx}px，样本 ${runs.length}`,
        ],
      });
    }
  } else {
    findings.push({
      rule: "PX2",
      severity: "info",
      message: `非白 run 样本仅 ${runs.length} 个，不足以估计线宽（墨迹过少或图面近乎空白），跳过线宽判定`,
    });
  }

  // PX3 尺寸 / DPI
  metrics.printedWidthMm = (image.width / dpi) * 25.4;
  metrics.printedHeightMm = (image.height / dpi) * 25.4;
  if (dpi < PIXEL_MIN_DPI || dpi > PIXEL_MAX_DPI) {
    findings.push({
      rule: "PX3",
      severity: "warn",
      message: `DPI ${dpi} 超出可用区间 ${PIXEL_MIN_DPI}-${PIXEL_MAX_DPI}，打印清晰度或元数据可疑`,
    });
  }
  if (metrics.printedWidthMm > PRINTABLE_WIDTH_MM || metrics.printedHeightMm > PRINTABLE_HEIGHT_MM) {
    findings.push({
      rule: "PX3",
      severity: "warn",
      message:
        `纸面尺寸 ${metrics.printedWidthMm.toFixed(1)}×${metrics.printedHeightMm.toFixed(1)}mm 超出 A4 可印区 ` +
        `${PRINTABLE_WIDTH_MM}×${PRINTABLE_HEIGHT_MM}mm，排版时将缩放（线宽与字高按同比例下降）`,
      evidence: [`${dpi}DPI${dpiEstimated ? "（估算）" : ""}`, `按 ${pxToMm(1).toFixed(4)}mm/px（96dpi）折算参考`],
    });
  }

  // PX4 图号声明（栅格侧不做 OCR，只核验声明存在性）
  if (declaredFigureNo === undefined) {
    findings.push({
      rule: "PX4",
      severity: "warn",
      message:
        "未声明图号：请在文件名标注（如 `xxx-fig3.png` / `xxx图3.png`）或显式提供 figure_no——" +
        "栅格图侧不做 OCR，无法从像素核验图号标注",
    });
  } else {
    findings.push({
      rule: "PX4",
      severity: "info",
      message: `按声明图号为图${declaredFigureNo}；栅格侧不做 OCR，图号标注存在性仍须人工确认`,
    });
  }

  return { metrics, findings };
}

/** 图像元数据（sharp 解码结果，供 I/O 包装构建 GrayImage）。 */
export type ImageDecodeResult = {
  image: GrayImage;
  /** 图像格式（sharp metadata.format）。 */
  format?: string;
  /** 元数据 DPI（缺失时 undefined ⇒ 分析侧按 96 估算）。 */
  dpi?: number;
};

/**
 * sharp 解码 → 灰度原始像素（**动态导入**：sharp 不可用时抛错，由调用方决定措辞）。
 *
 * `greyscale().raw()` 不做重采样——线宽判据依赖原始像素尺度，任何缩放都会改变它。
 */
export async function decodeImageToGray(buffer: Buffer): Promise<ImageDecodeResult> {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const dpi = await sharp(buffer)
    .metadata()
    .then(meta => (typeof meta.density === "number" && meta.density > 0 ? meta.density : undefined))
    .catch(() => undefined);
  return {
    image: { width: info.width, height: info.height, data },
    ...(typeof dpi === "number" ? { dpi } : {}),
  };
}

/** 单张图片的像素级门禁（解码失败抛错，由调用方转成工具错误）。 */
export async function analyzeImageBuffer(buffer: Buffer, options: PixelGateOptions = {}): Promise<PixelGateResult> {
  const decoded = await decodeImageToGray(buffer);
  return analyzeGrayImage(decoded.image, { ...options, ...(decoded.dpi === undefined ? {} : { dpi: decoded.dpi }) });
}
