/**
 * src/patent/figuregen — 提交**拼版页**（多视图 → A4 整页，imposition）。
 *
 * 用途：多视图一次产出（CAD 批次 C 的 `SATI_CAD_VIEWS=front,top,right`）时，每视图各一张
 * SVG，但**整页 A4 版式只有主视图有**（`submission-page.ts` 落的是"一幅图占一页"）⇒
 * 多视图交付缺"一整页"这个形态。本模块把多张视图 SVG 排进**同一张 A4**，作为附加产物
 * （`<name>-fig<N>-sheet.svg`）。
 *
 * **与单图落版页的分工**：`submission-page.ts` 管"一幅图一页"；本模块管"多幅视图共页"。
 * 两者的纸面常数、图号体例、页码体例**全部取自法域档案**（`office-profile.ts`）：
 * - 图号文本由**调用方**经 `figureCaption` 取得后传入（本模块不解释编号规则）；
 * - 页码文本由本模块经 `sheetNumberText` 取得（调用档案函数，不是自己拼字符串）；
 * 两处各解释一次必然漂移 ⇒ 本模块只"取用"档案结论。
 *
 * **排布规则（写死在此，便于复核）**：
 * 1. 候选列数 C = 1…N，行数 R = ⌈N/C⌉；视图按**阅读序**（自左至右、自上而下）落格，
 *    末行不满时左对齐留空；
 * 2. 格宽 = (版心宽 − (C−1)×格间距)/C；格高 = (版心高 − (R−1)×格间距 − 页码带 − 图号带)/R；
 * 3. **择优顺序**：统一缩放系数最大（字高最大 ⇒ 可辨性优先）→ 格形更接近方形 → 列数更少；
 * 4. 所有格共用**同一个**缩放系数（`uniformFigureZoom` 口径，恒 ≤ 1：不放大），且系数按
 *    **拼版后的单格可用区**算，不是按单图版心算——按单图算会把字压到不合规；
 * 5. 逐格在自己的格内居中；图号落在格底（图号带），页码落在版心底（档案体例）。
 *
 * **为什么按这个顺序择优**：附图页的第一判据是"缩小到三分之二仍可辨"（指南一部一章 4.3
 * / PCT Rule 11.13(c) / 37 CFR 1.84(k)），即**字高**；网格形状只是手段。故先最大化统一缩放
 * 系数（= 字高），同分再谈形状（接近方形 ⇒ 图形在格子里不浪费边），再同分取列数更少
 * （格更大 ⇒ 单个视图更好读）。
 *
 * **黑白不变式**：本模块只加白底矩形与黑色文字，不引入任何彩色（构造期黑白不变式）。
 *
 * **与既有单图落版页的一处刻意差异**：本模块的根 `<svg>` 开始标签**带闭合符**（`>`），
 * 产出是**合法 XML**，可被严格渲染器（rsvg / Inkscape / 浏览器 XML 解析）直接打开。
 * 既有 `submission-page.ts` 的落版页根标签缺 `>`（既有产物逐字节冻结，本批不改，见
 * `docs/notes/implemented/2026-11-12-figure-sheet-imposition.md` 的"已知问题"一节）⇒
 * 拼版页**不复制**该写法：新产物不继承一个已知的可打开性缺陷。
 *
 * **与 DSH 的对应关系**：DSH 的结构线稿渲染器一次产出多张 SVG 并落一份 manifest，但
 * **不落整页拼版页**（它的落版是单图 `fit_to_page`）。本模块补的是"多视图交付时整页 A4
 * 版式缺失"这一段。
 */

import { drawingComplianceFindings } from "./compliance.js";
import {
  minCharHeight,
  officeProfile,
  printableArea,
  sheetNumberText,
  type OfficeProfile,
  type TargetOffice,
} from "./office-profile.js";
import { uniformFigureZoom, type FigurePaperSize } from "./page-contract.js";
import { escapeXml, fmt as fmtShared } from "./render-utils.js";
import { DEFAULT_SOURCE_CHAR_MM, drawingSizeMm, nestDrawing, rootMarkers } from "./submission-page.js";

/** 拼版页坐标精度：2 位小数（纸面毫米；与单图落版页同口径）。 */
const SUBMISSION_COORD_DIGITS = 2;

const fmt = (value: number): string => fmtShared(value, SUBMISSION_COORD_DIGITS);

/** 拼版格（一个视图在拼版页上的内容）。 */
export type SubmissionSheetCell = {
  /** 视图标识（进清单与报告；不影响版式）。 */
  readonly view: string;
  /** 该格的图形 SVG 文本。 */
  readonly svg: string;
  /**
   * 该格图形的纸面尺寸（毫米）。
   *
   * 缺省时从 SVG 的 width/height 解析（单位归一在 `svgRootSizeMm` 一处）；调用方已知
   * 尺寸时**应当显式给出**（CAD 渲染器直接给纸面毫米，省一次解析也省一次口径分歧）。
   */
  readonly widthMm?: number;
  readonly heightMm?: number;
  /**
   * 该格下方要落的图号文本。
   *
   * **由调用方经 `figureCaption` 取得**（本模块不解释编号规则）。图形自身已带图号时
   * **不要传**——否则一页出现两个图号（与 `submission-page.ts` 的同一规则）。
   */
  readonly caption?: string | undefined;
};

/** 拼版页入参。 */
export type SubmissionSheetOptions = {
  /** 各视图（顺序即阅读序 ⇒ 落格顺序）。 */
  readonly cells: readonly SubmissionSheetCell[];
  /** 目标法域（决定纸面常数、图号与页码体例）；缺省 CNIPA。 */
  readonly office?: TargetOffice;
  /** 拼版页代表的图号（写进根元素的 `data-figure-no`，便于回读）。 */
  readonly figureNo?: number;
  /** 图号字号（毫米）；缺省 3.5mm（不低于三法域的字高下限 3.2mm）。 */
  readonly captionFontMm?: number;
  /** 图号与格底之间的间距（毫米）；缺省 4mm。 */
  readonly captionGapMm?: number;
  /** 页码字号（毫米）；缺省 3.2mm。 */
  readonly sheetFontMm?: number;
  /** 格与格之间的间距（毫米）；缺省 4mm。 */
  readonly cellGapMm?: number;
  /** 附图页序号 / 总页数（成对给出才落页码；体例由档案决定）。 */
  readonly sheetIndex?: number;
  readonly sheetTotal?: number;
  /**
   * 图内文字在**图形自身坐标系**下的字高（毫米）。
   *
   * 随渲染通路而变（内置渲染器 14px、Graphviz 以 pt 计、CAD 图以 mm 计），故由调用方
   * 声明而不是在此猜。缺省按内置渲染器折算（与单图落版页同口径）。
   */
  readonly sourceCharHeightMm?: number;
};

/** 单格的落版事实（进 sidecar 与报告）。 */
export type SubmissionSheetPlacement = {
  /** 视图标识。 */
  readonly view: string;
  /** 落版后的纸面宽（毫米）。 */
  readonly widthMm: number;
  /** 落版后的纸面高（毫米）。 */
  readonly heightMm: number;
  /** 该格落的图号（未落图号时缺省）。 */
  readonly caption?: string;
};

/** 拼版页度量。 */
export type SubmissionSheetMetrics = {
  /** **统一**缩放系数（所有格共用；≤ 1，不放大）。 */
  readonly pageScale: number;
  /** 网格列数。 */
  readonly columns: number;
  /** 网格行数。 */
  readonly rows: number;
  /** 单格宽（毫米，含图号带）。 */
  readonly cellWidthMm: number;
  /** 单格高（毫米，含图号带）。 */
  readonly cellHeightMm: number;
  /** 单格内可用绘图区宽（毫米）。 */
  readonly drawWidthMm: number;
  /** 单格内可用绘图区高（毫米，不含图号带）。 */
  readonly drawHeightMm: number;
  /** 落版后最宽的一格（毫米）。 */
  readonly placedWidthMm: number;
  /** 落版后最高的一格（毫米）。 */
  readonly placedHeightMm: number;
  /** 拼版后图内字高（毫米，统一）。 */
  readonly charHeightMm: number;
  /** 再缩 2/3 后的字高（毫米）。 */
  readonly reducedCharHeightMm: number;
  /** 法域字高下限（毫米）；档案未登记时缺省。 */
  readonly minCharHeightMm: number | undefined;
  /** 字高下限的性质（条文 / 实践）。 */
  readonly minCharHeightBasis: "statute" | "practice" | undefined;
  /** 拼版后字高是否满足法域下限。 */
  readonly charHeightCompliant: boolean;
  /** 图号基线 y（毫米，逐格）。 */
  readonly captionBaselineMm: readonly number[];
  /** 页码基线 y（毫米）；未落页码时缺省。 */
  readonly sheetBaselineMm?: number;
  /** 逐格落版事实。 */
  readonly placements: readonly SubmissionSheetPlacement[];
};

/** 拼版页产出。 */
export type SubmissionSheetResult = {
  /** 拼版页 SVG 文本。 */
  readonly svg: string;
  /** 拼版页度量。 */
  readonly metrics: SubmissionSheetMetrics;
  /** 版式告警（字高不合规等**如实报出**，不静默）。 */
  readonly warnings: readonly string[];
};

/** 网格候选（某一列数下的排布与统一缩放系数）。 */
type GridCandidate = {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidthMm: number;
  readonly cellHeightMm: number;
  readonly drawWidthMm: number;
  readonly drawHeightMm: number;
  readonly scale: number;
};

/** 格形接近方形的程度：1 = 正方形，越小越扁/越高。 */
function squareness(candidate: GridCandidate): number {
  const ratio = candidate.drawWidthMm / candidate.drawHeightMm;
  return Math.min(ratio, 1 / ratio);
}

/**
 * 在候选列数中择优（见模块头注的择优顺序）。
 *
 * 比较用 epsilon：两个候选的系数相差在浮点噪声内时，按"更接近方形"继续比，
 * 不把 1e-16 的差异当成"更大的系数"（那会让择优结果随浮点尾数漂移）。
 */
function pickCandidate(candidates: readonly GridCandidate[]): GridCandidate {
  const EPS = 1e-9;
  return candidates.reduce((best, candidate) => {
    if (candidate.scale > best.scale + EPS) return candidate;
    if (best.scale > candidate.scale + EPS) return best;
    const candidateSquare = squareness(candidate);
    const bestSquare = squareness(best);
    if (candidateSquare > bestSquare + EPS) return candidate;
    if (bestSquare > candidateSquare + EPS) return best;
    return candidate.columns < best.columns ? candidate : best;
  });
}

/**
 * 排布规划：枚举候选列数，算出各候选的格尺寸与统一缩放系数，取最优。
 *
 * 统一缩放系数按**单格可用区**算（`uniformFigureZoom` 的可用区覆盖参数），不是按整页
 * 版心算——按整页算会把图按"能放进整页"的大小落进小格子（图形撑出格子，字高被高估）。
 */
function planGrid(args: {
  readonly cells: number;
  readonly sizes: readonly FigurePaperSize[];
  readonly profile: OfficeProfile;
  readonly area: { widthMm: number; heightMm: number };
  readonly gapMm: number;
  readonly captionBandMm: number;
  readonly sheetBandMm: number;
}): GridCandidate {
  const candidates: GridCandidate[] = [];
  for (let columns = 1; columns <= args.cells; columns += 1) {
    const rows = Math.ceil(args.cells / columns);
    const cellWidthMm = (args.area.widthMm - (columns - 1) * args.gapMm) / columns;
    const cellHeightMm = (args.area.heightMm - (rows - 1) * args.gapMm - args.sheetBandMm) / rows;
    const drawHeightMm = cellHeightMm - args.captionBandMm;
    if (cellWidthMm <= 0 || drawHeightMm <= 0) continue;
    const scale = uniformFigureZoom(args.sizes, args.profile, {
      widthMm: cellWidthMm,
      heightMm: drawHeightMm,
    });
    candidates.push({
      columns,
      rows,
      cellWidthMm,
      cellHeightMm,
      drawWidthMm: cellWidthMm,
      drawHeightMm,
      scale,
    });
  }
  if (candidates.length === 0) {
    throw new TypeError(
      `版心不足以容纳 ${String(args.cells)} 个视图格（${args.profile.office} 版心 ` +
        `${args.area.widthMm.toFixed(1)}×${args.area.heightMm.toFixed(1)}mm）`,
    );
  }
  return pickCandidate(candidates);
}

/**
 * 生成提交拼版页（多视图共用一张 A4）。
 *
 * 图号与页码文本的来源：**图号**由调用方经 `figureCaption` 取得后按格传入；**页码**由
 * 本模块经 `sheetNumberText` 取得（档案体例）。本模块不解释编号规则。
 */
export function buildSubmissionSheet(options: SubmissionSheetOptions): SubmissionSheetResult {
  const profile = officeProfile(options.office ?? "cnipa");
  const area = printableArea(profile);
  const cells = options.cells;
  if (cells.length === 0) {
    throw new TypeError("拼版页至少要有一个视图格");
  }
  const captionFontMm = options.captionFontMm ?? 3.5;
  const captionGapMm = options.captionGapMm ?? 4;
  const sheetFontMm = options.sheetFontMm ?? 3.2;
  const gapMm = options.cellGapMm ?? 4;
  const warnings: string[] = [];

  const sizes: FigurePaperSize[] = cells.map(cell => {
    if (cell.widthMm !== undefined && cell.heightMm !== undefined) {
      return { widthMm: cell.widthMm, heightMm: cell.heightMm };
    }
    const parsed = drawingSizeMm(cell.svg);
    return { widthMm: cell.widthMm ?? parsed.widthMm, heightMm: cell.heightMm ?? parsed.heightMm };
  });

  const sheetText =
    options.sheetIndex === undefined || options.sheetTotal === undefined
      ? undefined
      : sheetNumberText(profile, options.sheetIndex, options.sheetTotal);
  // 图号带：只要有任一格带图号，整页的格高都要预留同一条带（格高统一 ⇒ 网格统一）。
  const hasCaption = cells.some(cell => cell.caption !== undefined);
  const captionBandMm = hasCaption ? captionGapMm + captionFontMm : 0;
  const sheetBandMm = sheetText === undefined ? 0 : sheetFontMm + 2;

  const grid = planGrid({
    cells: cells.length,
    sizes,
    profile,
    area,
    gapMm,
    captionBandMm,
    sheetBandMm,
  });

  const sourceCharMm = options.sourceCharHeightMm ?? DEFAULT_SOURCE_CHAR_MM;
  const charHeightMm = sourceCharMm * grid.scale;
  const limit = minCharHeight(profile);
  const charHeightCompliant = limit === undefined ? true : charHeightMm >= limit.mm - 1e-9;

  const parts: string[] = [];
  const placements: SubmissionSheetPlacement[] = [];
  const captionBaselines: number[] = [];
  cells.forEach((cell, index) => {
    const size = sizes[index]!;
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    const cellX = profile.margins.leftMm + column * (grid.cellWidthMm + gapMm);
    const cellY = profile.margins.topMm + row * (grid.cellHeightMm + gapMm);
    const placedWidthMm = size.widthMm * grid.scale;
    const placedHeightMm = size.heightMm * grid.scale;
    const drawX = cellX + (grid.drawWidthMm - placedWidthMm) / 2;
    const drawY = cellY + (grid.drawHeightMm - placedHeightMm) / 2;
    parts.push(
      `${nestDrawing(cell.svg, { xMm: drawX, yMm: drawY, widthMm: placedWidthMm, heightMm: placedHeightMm })}\n`,
    );
    if (cell.caption !== undefined) {
      // 图号在**格底**（图号带内），左右居中于本格：与单图落版页同口径（"标注在相应附图的
      // 正下方"，指南一部一章 4.3）。
      const baselineMm = cellY + grid.drawHeightMm + captionGapMm + captionFontMm * 0.85;
      captionBaselines.push(baselineMm);
      parts.push(
        `<text x="${fmt(cellX + grid.cellWidthMm / 2)}" y="${fmt(baselineMm)}" font-size="${fmt(captionFontMm)}" ` +
          `text-anchor="middle" fill="#000000">${escapeXml(cell.caption)}</text>\n`,
      );
    }
    placements.push({
      view: cell.view,
      widthMm: placedWidthMm,
      heightMm: placedHeightMm,
      ...(cell.caption === undefined ? {} : { caption: cell.caption }),
    });
  });

  const sheetBaselineMm = sheetText === undefined ? undefined : profile.paper.heightMm - profile.margins.bottomMm;
  if (sheetText !== undefined && sheetBaselineMm !== undefined) {
    parts.push(
      `<text x="${fmt(profile.paper.widthMm / 2)}" y="${fmt(sheetBaselineMm)}" font-size="${fmt(sheetFontMm)}" ` +
        `text-anchor="middle" fill="#000000">${escapeXml(sheetText)}</text>\n`,
    );
  }

  const maxPlacedWidthMm = placements.reduce((max, item) => Math.max(max, item.widthMm), 0);
  const maxPlacedHeightMm = placements.reduce((max, item) => Math.max(max, item.heightMm), 0);

  // 告警 1：缩小了（各格同一系数 ⇒ 同页字高一致）。
  if (grid.scale < 1) {
    warnings.push(
      `拼版按统一缩放系数 ${(grid.scale * 100).toFixed(0)}% 落版（${grid.columns} 列 × ${grid.rows} 行，` +
        `各格同一系数，保证同页字高一致）`,
    );
  }
  // 告警 2：图号字号低于法域下限（页级图号是纸上文字，同样受字高下限约束）。
  if (limit !== undefined && captionFontMm < limit.mm - 1e-9) {
    warnings.push(
      `图号字号 ${captionFontMm.toFixed(2)}mm 低于 ${profile.office} 字高下限 ${limit.mm.toFixed(2)}mm` +
        `（${limit.basis === "statute" ? "条文下限" : "实践下限，非法条数值"}）`,
    );
  }
  // 告警 3：拼版后字高低于法域下限——**如实报出**（不静默、不假装通过）。
  // 消息取合规核算模块（`compliance.ts`）的同一条口径，避免同一判据两处措辞。
  const charFindings = drawingComplianceFindings({
    profile,
    figureCount: 1,
    hasCaption: true,
    metrics: {
      placedWidthMm: maxPlacedWidthMm,
      placedHeightMm: maxPlacedHeightMm,
      charHeightMm,
    },
  });
  const charFinding = charFindings.find(finding => finding.id === "char-height-below-minimum");
  if (charFinding !== undefined) {
    warnings.push(`${charFinding.message} 拼版页建议：减少同页视图数（拆成多张拼版页）或改用单幅落版页。`);
  }

  const firstCell = cells[0];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ${rootMarkers(firstCell?.svg ?? "", options.figureNo)}` +
    `width="${fmt(profile.paper.widthMm)}mm" ` +
    `height="${fmt(profile.paper.heightMm)}mm" ` +
    `viewBox="0 0 ${fmt(profile.paper.widthMm)} ${fmt(profile.paper.heightMm)}" ` +
    `font-family="sans-serif">\n` +
    `<rect x="0" y="0" width="${fmt(profile.paper.widthMm)}" height="${fmt(profile.paper.heightMm)}" fill="#FFFFFF"/>\n` +
    `${parts.join("")}</svg>\n`;

  return {
    svg,
    metrics: {
      pageScale: grid.scale,
      columns: grid.columns,
      rows: grid.rows,
      cellWidthMm: grid.cellWidthMm,
      cellHeightMm: grid.cellHeightMm,
      drawWidthMm: grid.drawWidthMm,
      drawHeightMm: grid.drawHeightMm,
      placedWidthMm: maxPlacedWidthMm,
      placedHeightMm: maxPlacedHeightMm,
      charHeightMm,
      reducedCharHeightMm: charHeightMm * profile.reductionRatio,
      minCharHeightMm: limit?.mm,
      minCharHeightBasis: limit?.basis,
      charHeightCompliant,
      captionBaselineMm: captionBaselines,
      ...(sheetBaselineMm === undefined ? {} : { sheetBaselineMm }),
      placements,
    },
    warnings,
  };
}
