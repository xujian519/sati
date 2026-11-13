/**
 * src/patent/figuregen — 附图交付产物装配（`patent_figure_generate` 与 `patent_figure_project` 共用）。
 *
 * 为什么单列：两个制图工具的 `execute` 各自把「落版页生成 + sidecar 落盘」写了一遍——本批新增
 * `fit_to_page` 就同时改了 generate 与 project 两处，而漏改的后果是「同一个工具族对不同入口
 * 给出不同的 sidecar 字段/文件名」。产物清单是**交付契约**的一部分（`figureSidecarFileName`
 * 的形态、layout 字段名、落版页 `<name>-fig<N>-page.svg`），不是各工具的自由发挥。
 *
 * 边界（诚实声明）：本模块只管**装配**——把已经渲染好的 SVG 落成交付物、把已经算好的核验结论
 * 写进 sidecar。渲染、几何检查、报告措辞仍归各工具：它们的产物本来就不同（generate 出多幅
 * 内置/Graphviz 图 + 可选 A4 HTML；project 出单幅 CAD 投影 + 剖切/标注参数）。`patent_figure_check`
 * 是只读核验工具、不产文件，不在本模块的共享范围内。
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OfficeProfile } from "./office-profile.js";
import {
  type FigureSidecar,
  type FigureSidecarLayout,
  type FigureSidecarSheetLayout,
  figureSidecarFileName,
} from "./sidecar.js";
import { buildSubmissionPage } from "./submission-page.js";
import { buildSubmissionSheet, type SubmissionSheetCell } from "./submission-sheet.js";

export type SubmissionPageArtifact = {
  /** 落盘路径（绝对）。 */
  path: string;
  /** sidecar 的 `layout` 字段：落版后的纸面尺寸与字高（判"缩小到三分之二仍可辨"的输入）。 */
  layout: FigureSidecarLayout;
};

/** 拼版页落盘结果。 */
export type SubmissionSheetArtifact = {
  /** 落盘路径（绝对）。 */
  path: string;
  /** sidecar 的 `sheet_layout` 字段：网格形状、统一缩放与字高核验结论。 */
  layout: FigureSidecarSheetLayout;
};

/**
 * 生成并落盘提交落版页（`<name>-fig<N>-page.svg`），返回路径与 sidecar 的 `layout` 字段。
 *
 * `sourceCharHeightMm` 是**图形自身坐标系**下的图内字高（毫米）——它随渲染通路而变
 * （内置渲染器 14px、graphviz 以 pt 计、CAD 图以 mm 计），故由调用方声明而不是在此猜。
 * 猜错的后果是 sidecar 里的字高与图上实际不符，而那是 V7 判据的输入。
 */
export async function writeSubmissionPageArtifact(options: {
  outputDir: string;
  outputName: string;
  figureNo: number;
  /** 图形 SVG 文本（本模块渲染器的产物；png/pdf 不在交付产物内）。 */
  drawingSvg: string;
  office: OfficeProfile["office"];
  /** 附图页序号/总页数（成对给出才落页码，体例由法域档案决定）。 */
  sheet?: { index: number; total: number } | undefined;
  sourceCharHeightMm: number;
  /** 落版旋转角（0/90/180/270）；缺省不旋转。 */
  rotateDeg?: number | undefined;
  /** 图号字号（毫米）；缺省按模块默认值。 */
  captionFontMm?: number | undefined;
  /** 图形与图号之间的间距（毫米）；缺省按模块默认值。 */
  captionGapMm?: number | undefined;
  /** 页码字号（毫米）；缺省按模块默认值。 */
  sheetFontMm?: number | undefined;
}): Promise<SubmissionPageArtifact> {
  const fileName = `${options.outputName}-fig${options.figureNo}-page.svg`;
  const page = buildSubmissionPage({
    drawingSvg: options.drawingSvg,
    office: options.office,
    ...(options.sheet === undefined ? {} : { sheetIndex: options.sheet.index, sheetTotal: options.sheet.total }),
    sourceCharHeightMm: options.sourceCharHeightMm,
    ...(options.rotateDeg === undefined ? {} : { rotateDeg: options.rotateDeg }),
    ...(options.captionFontMm === undefined ? {} : { captionFontMm: options.captionFontMm }),
    ...(options.captionGapMm === undefined ? {} : { captionGapMm: options.captionGapMm }),
    ...(options.sheetFontMm === undefined ? {} : { sheetFontMm: options.sheetFontMm }),
  });
  const path = resolve(options.outputDir, fileName);
  await writeFile(path, page.svg, "utf8");
  return {
    path,
    layout: {
      file: fileName,
      page_scale: page.metrics.pageScale,
      placed_width_mm: page.metrics.placedWidthMm,
      placed_height_mm: page.metrics.placedHeightMm,
      char_height_mm: page.metrics.charHeightMm,
      ...(page.warnings.length === 0 ? {} : { warnings: page.warnings }),
    },
  };
}

/**
 * 生成并落盘提交拼版页（`<name>-fig<N>-sheet.svg`），返回路径与 sidecar 的 `sheet_layout`。
 *
 * 与 {@link writeSubmissionPageArtifact} 的分工：后者落"一幅图一页"，本函数落"多幅视图
 * 共一页"。两者的产物文件名不同（`-page.svg` / `-sheet.svg`），sidecar 字段也不同
 * （`layout` / `sheet_layout`）⇒ 不会互相覆盖，也不会让 `layout` 变成两义。
 *
 * `sourceCharHeightMm` 的口径与单图落版页一致：图形自身坐标系下的图内字高（毫米），
 * 由调用方按渲染通路声明（CAD 走 `cadRefFontMm`，内置渲染器 14px 折算）。
 */
export async function writeSubmissionSheetArtifact(options: {
  outputDir: string;
  outputName: string;
  figureNo: number;
  /** 各视图（顺序即阅读序 ⇒ 落格顺序）。 */
  cells: readonly SubmissionSheetCell[];
  office: OfficeProfile["office"];
  /** 附图页序号/总页数（成对给出才落页码，体例由法域档案决定）。 */
  sheet?: { index: number; total: number } | undefined;
  /** 图内文字在图形自身坐标系下的字高（毫米）。 */
  sourceCharHeightMm: number;
  /** 图号字号（毫米）；缺省按模块默认值。 */
  captionFontMm?: number | undefined;
  /** 图号与格底之间的间距（毫米）；缺省按模块默认值。 */
  captionGapMm?: number | undefined;
  /** 页码字号（毫米）；缺省按模块默认值。 */
  sheetFontMm?: number | undefined;
  /** 格与格之间的间距（毫米）；缺省按模块默认值。 */
  cellGapMm?: number | undefined;
}): Promise<SubmissionSheetArtifact> {
  const fileName = `${options.outputName}-fig${options.figureNo}-sheet.svg`;
  const sheet = buildSubmissionSheet({
    cells: options.cells,
    office: options.office,
    figureNo: options.figureNo,
    sourceCharHeightMm: options.sourceCharHeightMm,
    ...(options.sheet === undefined ? {} : { sheetIndex: options.sheet.index, sheetTotal: options.sheet.total }),
    ...(options.captionFontMm === undefined ? {} : { captionFontMm: options.captionFontMm }),
    ...(options.captionGapMm === undefined ? {} : { captionGapMm: options.captionGapMm }),
    ...(options.sheetFontMm === undefined ? {} : { sheetFontMm: options.sheetFontMm }),
    ...(options.cellGapMm === undefined ? {} : { cellGapMm: options.cellGapMm }),
  });
  const path = resolve(options.outputDir, fileName);
  await writeFile(path, sheet.svg, "utf8");
  return {
    path,
    layout: {
      file: fileName,
      cells: sheet.metrics.placements.length,
      columns: sheet.metrics.columns,
      rows: sheet.metrics.rows,
      page_scale: sheet.metrics.pageScale,
      cell_width_mm: sheet.metrics.cellWidthMm,
      cell_height_mm: sheet.metrics.cellHeightMm,
      char_height_mm: sheet.metrics.charHeightMm,
      reduced_char_height_mm: sheet.metrics.reducedCharHeightMm,
      ...(sheet.metrics.minCharHeightMm === undefined ? {} : { min_char_height_mm: sheet.metrics.minCharHeightMm }),
      ...(sheet.metrics.minCharHeightBasis === undefined
        ? {}
        : { min_char_height_basis: sheet.metrics.minCharHeightBasis }),
      char_height_compliant: sheet.metrics.charHeightCompliant,
      placements: sheet.metrics.placements.map(placement => ({
        view: placement.view,
        width_mm: placement.widthMm,
        height_mm: placement.heightMm,
        ...(placement.caption === undefined ? {} : { caption: placement.caption }),
      })),
      ...(sheet.warnings.length === 0 ? {} : { warnings: sheet.warnings }),
    },
  };
}

/**
 * 落盘附图 sidecar（`<name>-figures.json`），返回路径。
 *
 * 序列化形态（`JSON.stringify(sidecar, null, 2)` + 尾换行）是**契约的一部分**：sidecar 会被
 * 附图门（`figure-gate`）与 `patent_figure_check` 回读，也会进 git diff 供人工复核，故缩进与
 * 尾换行在两条通路里必须一致（否则同一案卷的两份产物在 diff 里显示为全量重写）。
 */
export async function writeFigureSidecar(options: {
  outputDir: string;
  outputName: string;
  sidecar: FigureSidecar;
}): Promise<string> {
  const path = resolve(options.outputDir, figureSidecarFileName(options.outputName));
  await writeFile(path, `${JSON.stringify(options.sidecar, null, 2)}\n`, "utf8");
  return path;
}
