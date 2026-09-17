/**
 * scripts/figure-print-calibration.ts — 打印校准页（把"推导阈值"变成"可实测"的仪器）。
 *
 * 背景：附图链路里几个阈值是**推导值**而非实测值——最小可辨打印字高 2.0mm、线宽 0.35mm、
 * 剖面线 0.2mm、栅格门禁的中间灰区间 [50,205]，都来自"纸面换算 + 判据推理"，没有在本机
 * 打印机/复印机/扫描仪上验证过。本页把它们按**当前代码常量**排版成一张 A4 测试页：
 * 打印（必要时按 2/3 复印）后逐项圈出"还能分辨"的最小档，即可把推导值换成实测值。
 *
 * 纪律：
 * - 版面与档位**全部取自源代码常量**（`page-contract` / `render-cad` / `pixel-gate`）：
 *   常量改了，校准页跟着变，不会校准到过期的数字上；
 * - 确定性输出（无时钟/随机；只写文件、不联网）。
 * - 本页是**测量工具**，不是交付附图：中间灰带与灰阶块刻意含灰色（交付契约只允许黑白）。
 *
 * 用法：
 *   npx tsx scripts/figure-print-calibration.ts [输出路径，默认 ./figure-print-calibration.svg]
 *   打印：A4、缩放 100%（关闭"适应页面"）；第二行按 2/3 缩小另打一份（复印机 66% 缩放等价）
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  MIN_PRINTED_FONT_MM,
  PAGE_MARGIN_LEFT_MM,
  PAGE_MARGIN_TOP_MM,
  PRINTABLE_HEIGHT_MM,
  PRINTABLE_WIDTH_MM,
} from "../src/patent/figuregen/page-contract.js";
import {
  CAD_HATCH_LINE_WIDTH_MM,
  CAD_HATCH_SPACING_MM,
  CAD_HIDDEN_DASH_MM,
  CAD_LINE_WIDTH_MM,
} from "../src/patent/figuregen/cad/index.js";
import {
  PIXEL_MID_GRAY_RANGE,
  PIXEL_MIN_DPI,
  PIXEL_MAX_DPI,
  PIXEL_WHITE_MIN,
} from "../src/patent/figuregen/pixel-gate.js";

/** 字高档位（毫米，纸面）：覆盖阈值两侧；每组含阈值本身与 2/3 缩小后的等价档。 */
export const FONT_STEPS_MM = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.5, 3.0] as const;
/** 线宽带位（毫米，纸面）。 */
export const LINE_STEPS_MM = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.5] as const;
/** 平行线最小间距档位（毫米，纸面）：为将来可能的"最小线间距"判据取实测。 */
export const GAP_STEPS_MM = [0.1, 0.15, 0.2, 0.3, 0.5, 0.8] as const;
/** 灰阶档位（0–255，8 位灰）：覆盖中间灰区间 [50,205] 的两端与"近白"判据。 */
export const GRAY_STEPS = [0, 32, 50, 64, 96, 128, 160, 205, 224, 245, 255] as const;

const INK = "#000000";
const LABEL_FONT_MM = 2.6;

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function text(x: number, y: number, content: string, sizeMm = LABEL_FONT_MM): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(sizeMm)}" fill="${INK}">${content}</text>`;
}

/** 生成校准页 SVG（纯函数：确定性、无 I/O）。 */
export function buildCalibrationSvg(): string {
  const left = PAGE_MARGIN_LEFT_MM;
  const top = PAGE_MARGIN_TOP_MM;
  const parts: string[] = [];
  let y = top;

  parts.push(text(left, y, "附图打印校准页（Sati）—— 圈出「仍能分辨」的最小档，回填到阈值常量", 4));
  y += 6;
  parts.push(
    text(
      left,
      y,
      `打印：A4 / 缩放 100%（关闭“适应页面”）。第二行须按 2/3 缩小另打一份` +
        `（复印机 66% 等价；指南一部一章 4.3：缩小到三分之二仍应能清晰分辨）。`,
    ),
  );
  y += 7;

  // 1) 字高：第一行原尺寸，第二行 2/3（阈值 = MIN_PRINTED_FONT_MM）
  parts.push(text(left, y, `1. 标号字高（毫米，纸面）——当前阈值 ${MIN_PRINTED_FONT_MM}mm`, 3));
  y += 5;
  for (const [rowIndex, shrink] of [1, 2 / 3].entries()) {
    let x = left + 30;
    parts.push(text(left, y + 2, rowIndex === 0 ? "原尺寸：" : "2/3 缩小："));
    for (const heightMm of FONT_STEPS_MM) {
      const sizeMm = heightMm * shrink;
      parts.push(`<text x="${fmt(x)}" y="${fmt(y + 2)}" font-size="${fmt(sizeMm)}" fill="${INK}">10</text>`);
      parts.push(text(x - 1, y + 8, `${fmt(sizeMm)}`, 1.8));
      x += Math.max(9, sizeMm * 6);
    }
    y += 14;
  }

  // 2) 线宽：实线档位 + 3) 虚线/剖面线（按当前渲染常量）
  parts.push(text(left, y, `2. 线宽（毫米）——轮廓当前 ${CAD_LINE_WIDTH_MM}mm、剖面线 ${CAD_HATCH_LINE_WIDTH_MM}mm`, 3));
  y += 5;
  for (const widthMm of LINE_STEPS_MM) {
    parts.push(
      `<line x1="${fmt(left + 34)}" y1="${fmt(y)}" x2="${fmt(left + 130)}" y2="${fmt(y)}" ` +
        `stroke="${INK}" stroke-width="${fmt(widthMm)}"/>`,
    );
    parts.push(text(left, y + 1, `${fmt(widthMm)}mm`));
    y += 5;
  }
  y += 2;
  parts.push(text(left, y, `3. 虚线（隐藏线 ${CAD_HIDDEN_DASH_MM[0]}/${CAD_HIDDEN_DASH_MM[1]}mm）与剖面线`, 3));
  y += 5;
  parts.push(
    `<line x1="${fmt(left + 34)}" y1="${fmt(y)}" x2="${fmt(left + 130)}" y2="${fmt(y)}" ` +
      `stroke="${INK}" stroke-width="${fmt(CAD_LINE_WIDTH_MM)}" ` +
      `stroke-dasharray="${CAD_HIDDEN_DASH_MM[0]} ${CAD_HIDDEN_DASH_MM[1]}"/>`,
  );
  parts.push(text(left, y + 1, "隐藏线"));
  // 剖面线样块：按真实参数（0.2mm 细实线、45°、纸面间距 CAD_HATCH_SPACING_MM）
  const hatchX = left + 140;
  const hatchSize = 26;
  {
    const x0 = hatchX;
    const x1 = hatchX + hatchSize;
    const y0 = y - 6;
    const y1 = y + 6;
    // 45° 线族 x − y = c；相邻线在纸面上的垂直距离 = 间距 ⇒ c 的步长为 间距·√2
    const step = CAD_HATCH_SPACING_MM * Math.SQRT2;
    const hatchLines: string[] = [];
    for (let c = x0 - y1; c <= x1 - y0; c += step) {
      const startX = Math.max(x0, y0 + c);
      const endX = Math.min(x1, y1 + c);
      if (endX - startX < 0.3) continue;
      hatchLines.push(
        `<line x1="${fmt(startX)}" y1="${fmt(startX - c)}" x2="${fmt(endX)}" y2="${fmt(endX - c)}" ` +
          `stroke="${INK}" stroke-width="${fmt(CAD_HATCH_LINE_WIDTH_MM)}"/>`,
      );
    }
    parts.push(
      `<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${hatchSize}" height="${fmt(y1 - y0)}" fill="none" ` +
        `stroke="${INK}" stroke-width="${fmt(CAD_LINE_WIDTH_MM)}"/>`,
      ...hatchLines,
      text(hatchX, y + 10, `剖面线样块（${CAD_HATCH_LINE_WIDTH_MM}mm / ${CAD_HATCH_SPACING_MM}mm 间距）`, 1.8),
    );
  }
  y += 20;

  // 4) 最小间距
  parts.push(text(left, y, "4. 平行线最小可分辨间距（毫米）", 3));
  y += 5;
  for (const gapMm of GAP_STEPS_MM) {
    parts.push(
      `<line x1="${fmt(left + 34)}" y1="${fmt(y - 1.5)}" x2="${fmt(left + 130)}" y2="${fmt(y - 1.5)}" stroke="${INK}" stroke-width="${fmt(CAD_LINE_WIDTH_MM)}"/>`,
      `<line x1="${fmt(left + 34)}" y1="${fmt(y - 1.5 + gapMm)}" x2="${fmt(left + 130)}" y2="${fmt(y - 1.5 + gapMm)}" stroke="${INK}" stroke-width="${fmt(CAD_LINE_WIDTH_MM)}"/>`,
      text(left, y, `间距 ${fmt(gapMm)}mm`),
    );
    y += Math.max(5, gapMm + 5);
  }
  y += 2;

  // 5) 灰阶：栅格门禁的中间灰区间与近白判据
  parts.push(
    text(
      left,
      y,
      `5. 灰阶（8 位灰）——栅格门禁：中间灰区间 ${PIXEL_MID_GRAY_RANGE[0]}–${PIXEL_MID_GRAY_RANGE[1]}、近白 ≥${PIXEL_WHITE_MIN}`,
      3,
    ),
  );
  y += 5;
  {
    let x = left;
    for (const gray of GRAY_STEPS) {
      parts.push(
        `<rect x="${fmt(x)}" y="${fmt(y)}" width="14" height="10" fill="rgb(${gray},${gray},${gray})" stroke="none"/>`,
      );
      parts.push(text(x, y + 14, `${gray}`, 1.8));
      x += 15;
    }
    y += 18;
  }

  parts.push(text(left, y, `6. 栅格分辨率区间（DPI）：${PIXEL_MIN_DPI}–${PIXEL_MAX_DPI}`));
  y += 5;
  parts.push(text(left, y + 4, "扫描/拍摄本页后：黑白性、线宽、灰阶、DPI 的实测结论回填到 pixel-gate 常量。", 2.2));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(A4_WIDTH_MM)}mm" height="${fmt(A4_HEIGHT_MM)}mm" ` +
    `viewBox="0 0 ${fmt(A4_WIDTH_MM)} ${fmt(A4_HEIGHT_MM)}" font-family="sans-serif">\n` +
    `<rect x="0" y="0" width="${fmt(A4_WIDTH_MM)}" height="${fmt(A4_HEIGHT_MM)}" fill="#FFFFFF"/>\n` +
    `${parts.join("\n")}\n</svg>\n`
  );
}

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? "figure-print-calibration.svg");
  await writeFile(outPath, buildCalibrationSvg(), "utf8");
  console.log(`已写出校准页：${outPath}`);
  console.log(`可印区 ${PRINTABLE_WIDTH_MM}×${PRINTABLE_HEIGHT_MM}mm；请以 A4 / 100% 打印，并按 2/3 缩小再打一份。`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
