/**
 * patent_figure_generate 的**报告文本**（行式摘要）。
 *
 * 为什么独立成文件：生成工具本体只做「渲染 → 落盘 → 装配 → 报告」四步，报告文本本身
 * 就有上百行（逐幅路径、图号体例、页码、落版页、跨调用一致性、索引状态、合规核算、
 * 核验发现、附图说明草稿），留在工具文件里会让它越过体量上限（800 行，见
 * scripts/check-architecture-boundaries.mjs 的 R3）。
 *
 * 报告是**模型可见面**：每一段都要回答「交付了什么、哪些没量测、哪些只是提示」。
 */

import {
  buildFigureBriefDraft,
  checkFigures,
  figureCaption,
  type DocumentKind,
  type FigureSpec,
  type Jurisdiction,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import { FIGURE_RENDER_GATE_ENV, type FigureRenderGate } from "./patentFigureReview.js";
import type { RenderedFigureFile } from "./patentFigureOutput.js";

/** 报告文本（行式摘要：逐幅路径、图号体例、页码、落版页、跨调用一致性、sidecar、核验发现与附图说明草稿）。 */
export function buildGenerateReportLines(args: {
  files: RenderedFigureFile[];
  pagePaths: { path: string; figure_no: number }[];
  profile: OfficeProfile;
  jurisdiction: Jurisdiction;
  figureCount: number;
  captionRendered: boolean;
  sheetText: string | undefined;
  sheetTotal: number | undefined;
  sidecarPath: string;
  htmlPath: string | undefined;
  check: ReturnType<typeof checkFigures>;
  /** 跨调用一致性的报告行（见 {@link crossCallReview}）。 */
  crossCallLines: string[];
  /** 渲染复核档位（off 档必须显式写「未量测」，见 AGENTS 第 11 条）。 */
  renderGate: FigureRenderGate;
  /**
   * 渲染复核的**缺陷**数（warn/fail）与 RC0 未量测说明数，两者分开计数：
   * 把 RC0（「箭头端头未量测」这类覆盖盲区）混进缺陷数，会让「没量到」看起来像
   * 「查出这么多问题」，也让「查了没缺陷」与「查出 N 条」无法区分（AGENTS 第 11 条）。
   */
  renderDefectCount: number;
  renderUnmeasuredCount: number;
  /** 提示级发现数（advisory）：报告但不当成缺陷。 */
  renderAdvisoryCount: number;
  brief: boolean | undefined;
  figures: FigureSpec[];
  inventionName: string | undefined;
  documentKind: DocumentKind | undefined;
  rendererLabel: string | undefined;
  /** 附图索引写入结果（生成即入索引；失败时 indexNote 说明原因）。 */
  indexed: boolean;
  indexNote: string | undefined;
  /** 自动分配的标号（自动发号开启时；为空表示没有自动发号）。 */
  numeralAssignments: readonly { id: string; numeral: number; explicit: boolean }[];
  /** 自动发号的实际步进（per-call 可覆盖；缺省 2）。 */
  numeralStep?: number;
  /** 族续号信息（给了 figure_family 时出现；applied=false 表示自动发号未开启⇒号段未共享）。 */
  numeralFamily?: { family: string; start: number; step: number; applied: boolean };
  /** 合规核算结论（法域条文对照；未命中时为空数组）。 */
  compliance: readonly { figure_no: number; id: string; severity: string; message: string }[];
}): string[] {
  const { files, pagePaths, profile, jurisdiction, figureCount, captionRendered } = args;
  const { sheetText, sheetTotal, sidecarPath, htmlPath, check, crossCallLines, brief, figures, rendererLabel } = args;
  const { renderGate, renderDefectCount, renderUnmeasuredCount, renderAdvisoryCount } = args;
  const lines: string[] = [
    `已生成 ${files.length} 幅附图（黑白线条，审查指南一部一章 4.3/4.6 合规` +
      (rendererLabel === undefined ? "）：" : `；渲染器: ${rendererLabel}）：`),
    ...files.map(file => `- 图${file.figure_no}: ${file.path}`),
    `- 图号：${captionRendered ? `${figureCaption(profile, 1, figureCount)} 式样，标注在图形正下方` : "本案仅一幅附图，按 " + profile.office + " 档案不标注图号"}` +
      `（法域 ${jurisdiction} ⇒ 档案 ${profile.office}）`,
    ...(sheetText === undefined
      ? []
      : [`- 附图页页码：本图页写作 ${sheetText}（${files.length} 幅，共 ${sheetTotal} 页）`]),
    ...pagePaths.map(page => `- 提交落版页（A4 整页，图号在图下、页码在版心上沿）: ${page.path}`),
    `- 附图 sidecar（FigureSpec 与生成期核验留痕，供 patent_figure_check / 附图门禁复用）: ${sidecarPath}`,
    args.indexed
      ? "- 附图索引：已写入 .sati/figures-index.json（生成物可被 search_patent_figure 直接检索）"
      : `- 附图索引：未写入（${args.indexNote ?? "原因未记录"}）——本次生成物不会被 search_patent_figure 检索到`,
    ...(args.numeralFamily !== undefined && !args.numeralFamily.applied
      ? [
          `- 自动标号：已声明同族标号系列「${args.numeralFamily.family}」，但自动发号未开启` +
            "（auto_numbering 未开且 SATI_FIGURE_AUTO_NUMBERING=off）⇒ 族内号段本次未共享，未发任何号",
        ]
      : args.numeralAssignments.length === 0
        ? []
        : [
            `- 自动标号：${String(args.numeralAssignments.length)} 个节点按 ${
              args.numeralFamily !== undefined
                ? `同族共享系列「${args.numeralFamily.family}」发号（起点 ${String(args.numeralFamily.start)}、步进 ${String(args.numeralFamily.step)}）`
                : `100 系列发号（每幅图一个系列，步进 ${String(args.numeralStep ?? 2)}）`
            }` + `——${args.numeralAssignments.map(a => `${a.id}→${String(a.numeral)}`).join("、")}`,
          ]),
    ...crossCallLines,
    renderGate === "off"
      ? `- 渲染复核：未运行（${FIGURE_RENDER_GATE_ENV}=off）——RC1–RC9 图面缺陷本次未量测，不能视为已核验无问题`
      : `- 渲染复核：RC1–RC9 已量测，发现 ${String(renderDefectCount)} 条缺陷` +
        (renderUnmeasuredCount === 0
          ? ""
          : `；另有 ${String(renderUnmeasuredCount)} 条 RC0 未量测说明（覆盖盲区，不计入缺陷）`) +
        (renderAdvisoryCount === 0
          ? ""
          : `；另有 ${String(renderAdvisoryCount)} 条提示级发现（advisory，不计入缺陷、不阻断）`) +
        `（档位 ${renderGate}${renderGate === "fail" ? "，fail 级发现已在产物落盘后阻断" : "，不阻断生成"}）`,
  ];
  if (htmlPath !== undefined) {
    lines.push(`A4 打印版式 HTML（PDF 可经 export_html 产出）: ${htmlPath}`);
  }

  if (args.compliance.length > 0) {
    lines.push(
      "",
      "附图合规核算（法域条文对照；物理量取落版度量，无落版页时取图形自身实测尺寸）：",
      ...args.compliance.map(row => `- [${row.severity.toUpperCase()}] 图${row.figure_no} ${row.id}: ${row.message}`),
    );
  }

  if (check.findings.length > 0) {
    lines.push(
      "",
      "附图核验（生成期 spec_text 为空，结构 V*、渲染复核 RC*、跨调用结论；V2/V3 以 patent_figure_check 提交说明书后为准）：",
      ...check.findings.map(
        finding =>
          `- [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
          (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
      ),
    );
  }

  if (brief !== false) {
    const briefDraft = buildFigureBriefDraft(figures, {
      inventionName: args.inventionName,
      documentKind: args.documentKind,
      jurisdiction: jurisdiction,
    });
    lines.push("", "--- 附图说明草稿（可直接并入说明书） ---", briefDraft);
  }
  return lines;
}
