/**
 * src/patent/figuregen/cad — 结构图**产物装配**（SVG / 落版页 / manifest / sidecar 落盘）。
 *
 * 用途：把编排层（`project.ts`）的投影结果落成交付物，并把"视图 → 文件 → 几何事实 /
 * 件号归属"的对应写进 manifest。
 *
 * **与 DSH 的对应关系**：DSH 的结构线稿渲染器同样一次产出多张 SVG 并落一份 manifest
 * （`freecad-structure-script.ts` 的 `manifest.json`）。本模块的差异：
 * - DSH 的 manifest 由脚本写、只记锚点与零件投影占位；本模块的 manifest 由 Sati 侧装配，
 *   额外记**每零件的 3D 几何事实**（包围盒/质心/面积/体积）与**件号归属**（含归属零件序号）；
 * - DSH 的 SVG 由脚本产出（TechDraw 片段）；本仓的 SVG 由 `render-cad.ts` 产出（黑白不变式、
 *   `data-ref`、A4 适配、回读自检全部复用既有交付契约）。
 *
 * **架构差异与理由**：产物装配与投影编排分开，是因为二者的失败语义不同——投影失败**不落盘**
 * （fail-closed），而落盘失败要报出"哪一步写不下去"。混在一个函数里时，前者的"不落盘"
 * 承诺会被后者的半成品落盘破坏。
 *
 * **多视图时的文件口径**：单视图 ⇒ SVG 名沿用 `${outputName}-fig${N}.svg`（既有命名不变）；
 * 多视图 ⇒ 每个视图一张 `${outputName}-fig${N}-${view}.svg`，并落一份 manifest 串起全部视图。
 * sidecar 的契约是"一幅图一个文件条目"（`figures[].figure_no` 唯一）⇒ 多视图时 sidecar 记
 * **主视图**，其余视图由 manifest 承载（两者互补，不改 sidecar 的既有语义）。
 *
 * **多视图时的整页版式**：多视图 + `fit_to_page` ⇒ 额外落一张**拼版页**
 * （`${outputName}-fig${N}-sheet.svg`，各视图排进同一张 A4；网格与统一缩放的口径见
 * `figuregen/submission-sheet.ts`）。它是**附加**产物：单图落版页（`-page.svg`）照旧产出，
 * sidecar 的 `layout` 字段语义不变（单图口径），拼版页的信息另落 `sheet_layout` 字段。
 * 单视图不产拼版页（默认路径零变化）。
 */

import { mkdir, stat as statFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { exportSvgTextToPath, type InkscapeProbe } from "../inkscape-renderer.js";
import { figureCaption, type OfficeProfile } from "../office-profile.js";
import { writeFigureSidecar, writeSubmissionPageArtifact, writeSubmissionSheetArtifact } from "../deliverables.js";
import { buildDeliverableManifest } from "../deliverable-manifest.js";
import {
  buildFigureSidecar,
  type FigureSidecarLayout,
  type FigureSidecarSheet,
  type FigureSidecarSheetLayout,
} from "../sidecar.js";
import type { DocumentKind, FigureSpec, Jurisdiction } from "../types.js";
import { cadRefFontMm } from "./ref-font.js";
import type { CadProjectionOutcome } from "./project.js";
import { buildCadStructureManifest, writeCadStructureManifest } from "./structure-manifest.js";
import type { CadView } from "./types.js";

/** 产物装配失败（落盘阶段）：带路径与原因，供工具层转成结构化错误（不丢细节）。 */
export class CadArtifactError extends Error {
  /** 出问题的文件路径。 */
  readonly path: string;
  /** 失败原因码（可选）。 */
  readonly reason: string | undefined;

  constructor(message: string, path: string, reason?: string) {
    super(message);
    this.name = "CadArtifactError";
    this.path = path;
    this.reason = reason;
  }
}

/** 产物装配入参。 */
export type CadArtifactsInput = {
  outputDir: string;
  outputName: string;
  figureNo: number;
  figureCount: number;
  /** 是否另出一张 A4 落版页（主视图）。 */
  fitToPage: boolean | undefined;
  jurisdiction: Jurisdiction;
  documentKind: DocumentKind | undefined;
  profile: OfficeProfile;
  sheet?: { index: number; total: number };
  sheetText?: string;
  inkscape?: InkscapeProbe;
  hiddenLines: boolean;
  /** 投影编排的结果。 */
  outcome: CadProjectionOutcome;
  /** 模型路径（写进 manifest，作为零件口径的来源）。 */
  stepPath: string;
  /** 工具名（错误上下文）。 */
  tool: string;
  /** 落版样式（旋转角与图号/页码字号）；缺省用模块默认值。 */
  submissionStyle?: {
    readonly rotateDeg?: number;
    readonly captionFontMm?: number;
    readonly captionGapMm?: number;
    readonly sheetFontMm?: number;
  };
};

/** 产物装配结果。 */
export type CadArtifactsResult = {
  /** 各视图的 SVG 路径（顺序与视图一致）。 */
  svgPaths: string[];
  /** 主视图的落版页路径（未开启时缺省）。 */
  pagePath: string | undefined;
  /** 拼版页路径（多视图且开启落版时出现；单视图不产）。 */
  sheetPath: string | undefined;
  /** 拼版页摘要（网格形状、统一缩放、字高核验；未产拼版页时缺省）。 */
  sheetLayout: FigureSidecarSheetLayout | undefined;
  /** manifest 路径（视图 → 文件 → 几何事实 / 件号归属）。 */
  manifestPath: string;
  /** sidecar 路径。 */
  sidecarPath: string;
  /** 图号注记（未编号时缺省）。 */
  caption: string | undefined;
};

/** 视图的 SVG 文件名（单视图沿用既有命名；多视图带视图名后缀）。 */
export function cadViewFileName(outputName: string, figureNo: number, view: CadView, multi: boolean): string {
  return multi ? `${outputName}-fig${figureNo}-${view}.svg` : `${outputName}-fig${figureNo}.svg`;
}

/**
 * 落盘结构图的全部产物。
 *
 * 顺序是契约的一部分：先写 SVG → 再写落版页 → 再做文本转路径（可选收尾）→ 再写 manifest
 * 与 sidecar（sidecar 记录"已转路径"这一事实，故转路径必须在其之前）。
 */
export async function writeCadArtifacts(input: CadArtifactsInput): Promise<CadArtifactsResult> {
  const { outputDir, outputName, figureNo, outcome } = input;
  await mkdir(outputDir, { recursive: true });
  const multi = outcome.views.length > 1;
  const svgPaths: string[] = [];
  for (const view of outcome.views) {
    const path = resolve(outputDir, cadViewFileName(outputName, figureNo, view.view, multi));
    await writeFile(path, view.render.svg, "utf8");
    svgPaths.push(path);
  }

  const caption = figureCaption(input.profile, figureNo, input.figureCount);
  const sheetField: FigureSidecarSheet | undefined =
    input.sheet === undefined || input.sheetText === undefined ? undefined : { ...input.sheet, text: input.sheetText };
  let layoutField: FigureSidecarLayout | undefined;
  let sheetLayoutField: FigureSidecarSheetLayout | undefined;
  let pagePath: string | undefined;
  let sheetPath: string | undefined;
  if (input.fitToPage === true) {
    // 落版页只对主视图产出（单图口径；`layout` 字段的语义不变）。
    const page = await writeSubmissionPageArtifact({
      outputDir,
      outputName,
      figureNo,
      drawingSvg: outcome.primary.render.svg,
      office: input.profile.office,
      ...(input.sheet === undefined ? {} : { sheet: { index: input.sheet.index, total: input.sheet.total } }),
      sourceCharHeightMm: cadRefFontMm(input.jurisdiction),
      ...(input.submissionStyle?.rotateDeg === undefined ? {} : { rotateDeg: input.submissionStyle.rotateDeg }),
      ...(input.submissionStyle?.captionFontMm === undefined
        ? {}
        : { captionFontMm: input.submissionStyle.captionFontMm }),
      ...(input.submissionStyle?.captionGapMm === undefined
        ? {}
        : { captionGapMm: input.submissionStyle.captionGapMm }),
      ...(input.submissionStyle?.sheetFontMm === undefined ? {} : { sheetFontMm: input.submissionStyle.sheetFontMm }),
    });
    pagePath = page.path;
    layoutField = page.layout;
    // 拼版页（**附加**产物）：多视图时把各视图排进同一张 A4，补上"整页版式"这一形态。
    // 单视图不产（走既有单图落版页，默认路径零变化）。
    if (multi) {
      const sheet = await writeSubmissionSheetArtifact({
        outputDir,
        outputName,
        figureNo,
        cells: outcome.views.map(view => ({
          view: view.view,
          svg: view.render.svg,
          widthMm: view.render.widthMm,
          heightMm: view.render.heightMm,
          // CAD 图的图号已由渲染器画在图面下沿（`render-cad.ts` 经 `figureCaption` 取得），
          // 格内不再重复落图号——一页出现两个图号是缺陷。
          caption: undefined,
        })),
        office: input.profile.office,
        ...(input.sheet === undefined ? {} : { sheet: { index: input.sheet.index, total: input.sheet.total } }),
        sourceCharHeightMm: cadRefFontMm(input.jurisdiction),
        ...(input.submissionStyle?.captionFontMm === undefined
          ? {}
          : { captionFontMm: input.submissionStyle.captionFontMm }),
        ...(input.submissionStyle?.captionGapMm === undefined
          ? {}
          : { captionGapMm: input.submissionStyle.captionGapMm }),
        ...(input.submissionStyle?.sheetFontMm === undefined ? {} : { sheetFontMm: input.submissionStyle.sheetFontMm }),
      });
      sheetPath = sheet.path;
      sheetLayoutField = sheet.layout;
    }
  }

  // 字体独立导出（可选收尾，最后一步）：放在图形与落版页都落盘之后、sidecar 之前
  // （此后不再解析这些文件的文本；sidecar 记录已转路径这一事实）。
  if (input.inkscape !== undefined) {
    for (const target of [
      ...svgPaths,
      ...(pagePath === undefined ? [] : [pagePath]),
      ...(sheetPath === undefined ? [] : [sheetPath]),
    ]) {
      const outcomeText = await exportSvgTextToPath({ path: target, cmd: input.inkscape.cmd });
      if (!outcomeText.ok) {
        throw new CadArtifactError(
          `文本转路径失败（${target}）：${outcomeText.error}${
            outcomeText.installHint === undefined ? "" : `——${outcomeText.installHint}`
          }`,
          target,
          outcomeText.reason,
        );
      }
    }
  }

  const manifest = buildCadStructureManifest({
    figureNo,
    stepPath: input.stepPath,
    parts: outcome.parts,
    views: outcome.views.map((view, index) => ({
      view: view.view,
      file: svgPaths[index] ?? "",
      geometry: {
        scale: view.render.scale,
        width_mm: view.render.widthMm,
        height_mm: view.render.heightMm,
        visible_edges: view.render.visibleEdges,
        hidden_edges: view.render.hiddenEdges,
        cut_faces: view.render.cutFaces,
        hatch_segments: view.render.hatchSegments,
      },
      bindings: view.bindings,
    })),
  });
  const manifestPath = await writeCadStructureManifest({
    outputDir,
    outputName,
    figureNo,
    manifest,
  });

  // 图号 + 标记骨架 spec：CAD 图的画幅由投影几何决定（不由本模块布局决定），但**标记**
  // 是真实存在的图面内容 ⇒ 落进 nodes（label=标号、ref=标记），使 V2/V4 在定稿期可用。
  const primary = outcome.primary;
  const skeleton: FigureSpec = {
    figure_no: figureNo,
    kind: "block",
    nodes: primary.annotations.map(annotation => ({
      id: `ref-${annotation.ref}`,
      label: String(annotation.ref),
      ref: annotation.ref,
    })),
    edges: [],
  };
  // 交付物清单：逐视图 SVG + 落版页 + 拼版页（不含 manifest 自身——它承载清单，自指）。
  const deliverables = await buildDeliverableManifest([
    ...svgPaths.map(path => ({ role: "figure" as const, path })),
    ...(pagePath === undefined ? [] : [{ role: "submission-page" as const, path: pagePath }]),
    ...(sheetPath === undefined ? [] : [{ role: "submission-page" as const, path: sheetPath }]),
  ]);
  // 输入件时刻：模型文件的落盘时刻（CAD 通路唯一的文件型输入）。
  const inputMtimes: { label: string; mtimeMs: number }[] = [];
  try {
    const stat = await statFile(input.stepPath);
    inputMtimes.push({ label: `模型 ${basename(input.stepPath)}`, mtimeMs: stat.mtimeMs });
  } catch {
    // 模型时刻取不到（文件已被移动/删除）⇒ 不登记输入件 ⇒ 时序门**不执行**，
    // 由核验侧如实声明「时序门未执行」，不假装通过。
  }

  const sidecarPath = await writeFigureSidecar({
    outputDir,
    outputName,
    sidecar: buildFigureSidecar({
      outputName,
      renderer: "cad",
      jurisdiction: input.jurisdiction,
      documentKind: input.documentKind,
      // 交付物清单（角色 + 文件名 + sha256 + 字节数 + mtime）与输入件时刻：
      // CAD 通路**有文件型输入**（模型 STEP）⇒ 时序门可真正执行——「渲染件晚于输入件」
      // 是「交出去的那份确实对应当前模型」的可核证据（清单未登记输入件时，门禁如实
      // 声明「时序门未执行」，不假装通过）。
      ...(deliverables.length === 0 ? {} : { deliverables }),
      ...(inputMtimes.length === 0 ? {} : { deliverableInputs: inputMtimes }),
      files: [
        {
          figure_no: figureNo,
          path: svgPaths[0] ?? "",
          ...(caption === undefined ? {} : { caption }),
          ...(sheetField === undefined ? {} : { sheet: sheetField }),
          ...(layoutField === undefined ? {} : { layout: layoutField }),
          ...(sheetLayoutField === undefined ? {} : { sheet_layout: sheetLayoutField }),
          geometry: {
            source: "cad",
            view: primary.view,
            scale: primary.render.scale,
            width_mm: primary.render.widthMm,
            height_mm: primary.render.heightMm,
            hidden_lines: input.hiddenLines,
            ...(primary.table.section === undefined
              ? {}
              : {
                  section: {
                    offset_mm: primary.table.section.offset_mm,
                    cut_faces: primary.render.cutFaces,
                    hatch_segments: primary.render.hatchSegments,
                  },
                }),
            ...(primary.annotations.length === 0
              ? {}
              : {
                  ref_numerals: primary.annotations.map(annotation => annotation.ref),
                  label_placements: primary.render.labels.map(label => ({
                    ref: label.ref,
                    offset_mm: [label.labelMm[0] - label.anchorMm[0], label.labelMm[1] - label.anchorMm[1]] as [
                      number,
                      number,
                    ],
                    degraded: label.degraded,
                    // 能走到落盘说明 strict 已经放下；失败在 renderCadSvg 抛出，不会写 sidecar。
                    strict_failure: false,
                  })),
                }),
            findings: [...primary.findings],
          },
        },
      ],
      figures: [skeleton],
      check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
      // 文本侧规则在投影期不适用（无说明书文本），核验由附图门在定稿期跑
      skipTextRules: true,
      ...(input.inkscape === undefined ? {} : { textToPath: true }),
    }),
  });

  return { svgPaths, pagePath, sheetPath, sheetLayout: sheetLayoutField, manifestPath, sidecarPath, caption };
}
