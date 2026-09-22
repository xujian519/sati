/**
 * patent_figure_project — 由已有 3D 源（STEP）无头投影出专利附图（黑白 SVG）。
 *
 * 定位（方案 P2 阶段一）：**已有 STEP/3D 源 → 直接投影**。价值最高、风险最低（实测
 * 导入 + 投影各数毫秒），且交付契约与本模块其它附图完全一致（黑白线条 + 图号标注 +
 * A4 可印区适配 + sidecar 留痕）。阶段二（由模型产几何 DSL）不做——模型直接产三维
 * 几何的可靠性不足。
 *
 * 边界（诚实声明）：
 * - **不产几何**：只投影已有 STEP，不做建模；
 * - **剖切限于全剖视图**：剖切面垂直于视图方向（旋转剖/阶梯剖/局部剖不做）；剖面线为
 *   45° 细实线，按纸面毫米间距确定性填充；
 * - **附图标记只标注调用方给的锚点**：锚点用模型坐标（毫米），图面位置（引线方向）由
 *   本工具按"向图外引"确定，可经 label_offset_mm 显式指定；
 * - 依赖本机 FreeCAD（`SATI_FREECAD_CMD` 或探测安装路径）：缺失即 fail-closed，
 * 不静默回退内置渲染器。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  CAD_VIEWS,
  buildFigureSidecar,
  buildSubmissionPage,
  checkCadProjection,
  figureCaption,
  figureSidecarFileName,
  isCadSectionView,
  isCadView,
  printableArea,
  profileForJurisdiction,
  projectStep,
  renderCadSvg,
  resolveFreecadCmd,
  sheetNumberText,
  type CadRefAnnotation,
  type CadRunner,
  type CadView,
  type DocumentKind,
  type FigureSidecarLayout,
  type FigureSidecarSheet,
  type FigureSpec,
  type Jurisdiction,
} from "../../patent/figuregen/index.js";
import { caseOutputsDir } from "../../patent/paths.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { JURISDICTIONS, toFigureCount, toJurisdiction, toSheet } from "./patentFigureSchema.js";

/** 附图标记标注入参（模型坐标锚点 + 可选图面偏移）。 */
export type PatentFigureProjectAnnotation = {
  ref: number;
  at_mm: number[];
  label_offset_mm?: number[];
};

export type PatentFigureProjectInput = {
  step_path: string;
  output_name: string;
  view: string;
  figure_no?: number;
  hidden_lines?: boolean;
  section_offset_mm?: number;
  annotations?: PatentFigureProjectAnnotation[];
  case_id?: string;
  output_dir?: string;
  jurisdiction?: string;
  document_kind?: string;
  tolerance_mm?: number;
  figure_count?: number;
  sheet_index?: number;
  sheet_total?: number;
  fit_to_page?: boolean;
};

/** 标注数量上限（超出属调用方构造错误：图面容不下，且多为误传）。 */
export const MAX_CAD_ANNOTATIONS = 24;
/** 标号图面偏移的绝对值上限（毫米）：防离谱偏移把几何压到不可见。 */
export const MAX_CAD_LABEL_OFFSET_MM = 50;

export type CreatePatentFigureProjectToolOptions = {
  /** 注入的进程运行器（单测不真跑 FreeCAD）。 */
  runner?: CadRunner;
  /** 注入的 freecadcmd 路径（缺省走能力探测）。 */
  freecadCmd?: string;
};

export function createPatentFigureProjectTool(
  options: CreatePatentFigureProjectToolOptions = {},
): SatiToolDefinition<PatentFigureProjectInput> {
  return {
    name: "patent_figure_project",
    outputSchema: { type: "object", properties: {} },
    aliases: ["PatentFigureProject", "figure_project"],
    title: "Project 3D Model to Patent Figure",
    description:
      "Project an existing STEP/3D model into a patent-style figure (deterministic black-and-white SVG, " +
      "hidden-line removal, millimetre-accurate orthographic projection) using a headless FreeCAD on this " +
      "machine. Views: front/back/left/right/top/bottom/iso. `section_offset_mm` produces a full section " +
      "view (cut plane perpendicular to the view direction, facing material removed, cut faces hatched at " +
      "45 degrees; full sections only — no rotated, stepped or local sections); `annotations` places " +
      "reference numerals anchored at model-space points, each drawn as a leader line plus the numeral. " +
      "The SVG follows this project's drawing contract (A4 printable area, 图N caption, numerals carry " +
      "data-ref for readback) with a sidecar recording the projection, section and numeral parameters. It " +
      "does not create geometry and does not read dimension or centre lines from the model. Requires a " +
      "local FreeCAD install (SATI_FREECAD_CMD or the standard app path); missing install fails closed.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["step_path", "output_name", "view"],
      properties: {
        step_path: { type: "string", description: "STEP 文件路径（工作区相对或绝对）" },
        output_name: { type: "string", description: "输出文件名主干（生成 <name>-fig<N>.svg 与 <name>-figures.json）" },
        view: { type: "string", enum: [...CAD_VIEWS], description: "投影方向（正投影；iso 为轴测图）" },
        figure_no: { type: "number", description: "图号（默认 1，用于图号标注与 sidecar）" },
        hidden_lines: {
          type: "boolean",
          description: "是否绘制隐藏线（默认 false：CNIPA 实务以剖视图表达内部结构，虚线易与标记线混淆）",
        },
        section_offset_mm: {
          type: "number",
          description:
            "全剖视图：沿视图方向的剖切位置（模型坐标，毫米）——剖切面垂直于视图方向、保留远离观者的一侧，剖切面按 45° 细实线填充；仅 front/back/left/right/top/bottom 可剖切（iso 不可）",
        },
        annotations: {
          type: "array",
          description: "附图标记标注（缺省出未标注的投影图）：每项一个标记，锚点为模型坐标（毫米）",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "at_mm"],
            properties: {
              ref: { type: "integer", description: "附图标记（细则第 21 条：须与说明书文字部分一致）" },
              at_mm: {
                type: "array",
                description: "标记锚点（模型坐标，毫米；[x, y, z]）：投影后作为引线起点",
                items: { type: "number" },
              },
              label_offset_mm: {
                type: "array",
                description: "标号相对锚点的图面偏移（毫米，[dx, dy]；+x 向右、+y 向下）；缺省按远离图心方向自动引线",
                items: { type: "number" },
              },
            },
          },
        },
        case_id: { type: "string", description: "案卷 id；提供时落盘 data/cases/<caseId>/outputs/" },
        output_dir: { type: "string", description: "显式输出目录（覆盖默认 .sati/figures/ 与 case_id）" },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description:
            "Target office (default cn): cn=CNIPA (图N), us=USPTO (FIG. N, 37 CFR 1.84 profile), " +
            "pct=PCT (Fig. N, PCT Rule 11 profile); single-figure cases are unnumbered under pct/us",
        },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "发明/实用新型（写入 sidecar，供附图门判定 V9）",
        },
        tolerance_mm: { type: "number", description: "投影离散化容差（毫米，默认 0.5；越小越平滑、边表越大）" },
        figure_count: {
          type: "integer",
          minimum: 1,
          description:
            "本案附图总幅数（缺省 1）：本工具一次只投影一幅，多视图案卷须声明总数——它决定是否需要图号" +
            "（单幅在 pct/us 不得出现 Fig./FIG.）",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "附图页序号（与 sheet_total 成对声明；缺省不落页码）",
        },
        sheet_total: { type: "integer", minimum: 1, description: "附图页总页数（成对声明；页码体例按法域档案）" },
        fit_to_page: {
          type: "boolean",
          description: "是否另产提交落版页 <name>-fig<N>-page.svg（默认 false：投影图 SVG 仍是主产物）",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      if (!isCadView(input.view)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `非法 view "${input.view}"（可用: ${CAD_VIEWS.join(", ")}）`,
          { tool: "patent_figure_project" },
        );
      }
      const view: CadView = input.view;
      if (!/^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,100}$/u.test(input.output_name)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `非法 output_name: ${JSON.stringify(input.output_name)}`, {
          tool: "patent_figure_project",
        });
      }
      const figureNo =
        Number.isInteger(input.figure_no) && (input.figure_no ?? 0) > 0 ? (input.figure_no as number) : 1;
      const jurisdiction: Jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const area = printableArea(profile);
      const figureCount = toFigureCount(input.figure_count, 1);
      const sheet = toSheet({ sheet_index: input.sheet_index, sheet_total: input.sheet_total });
      if (sheet === undefined && (input.sheet_index !== undefined || input.sheet_total !== undefined)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          "sheet_index 与 sheet_total 须成对给出且均 ≥1（附图页码体例由法域档案决定，缺一项无法判定）",
          { tool: "patent_figure_project" },
        );
      }
      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      const hiddenLines = input.hidden_lines === true;

      // 剖切：仅轴对齐视图可剖（rotate/stepped/local section 不做）
      const sectionOffset = input.section_offset_mm;
      if (sectionOffset !== undefined && !isCadSectionView(view)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `视图 ${view} 不能剖切：剖切要求轴对齐视图（front/back/left/right/top/bottom），轴测图无"剖切面"语义`,
          { tool: "patent_figure_project" },
        );
      }
      if (sectionOffset !== undefined && !Number.isFinite(sectionOffset)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `section_offset_mm 应为有限数字`, {
          tool: "patent_figure_project",
        });
      }

      // 附图标记标注：逐项校验（锚点须是三元有限数组，偏移须在可交付范围内）
      const annotations: CadRefAnnotation[] = [];
      const rawAnnotations = input.annotations ?? [];
      if (rawAnnotations.length > MAX_CAD_ANNOTATIONS) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `annotations 至多 ${MAX_CAD_ANNOTATIONS} 项（收到 ${rawAnnotations.length} 项）`,
          { tool: "patent_figure_project" },
        );
      }
      for (const [index, annotation] of rawAnnotations.entries()) {
        const position = `annotations[${index}]`;
        if (!Number.isInteger(annotation.ref) || annotation.ref <= 0 || annotation.ref > 999) {
          throw new SatiToolRuntimeError("invalid_tool_input", `${position}.ref 应为 1–999 的整数`, {
            tool: "patent_figure_project",
          });
        }
        if (
          !Array.isArray(annotation.at_mm) ||
          annotation.at_mm.length !== 3 ||
          !annotation.at_mm.every(value => typeof value === "number" && Number.isFinite(value))
        ) {
          throw new SatiToolRuntimeError(
            "invalid_tool_input",
            `${position}.at_mm 应为三个有限数字（模型坐标 [x, y, z]，毫米）`,
            { tool: "patent_figure_project" },
          );
        }
        const offset = annotation.label_offset_mm;
        if (offset !== undefined) {
          if (
            !Array.isArray(offset) ||
            offset.length !== 2 ||
            !offset.every(value => typeof value === "number" && Number.isFinite(value))
          ) {
            throw new SatiToolRuntimeError(
              "invalid_tool_input",
              `${position}.label_offset_mm 应为两个有限数字（图面偏移 [dx, dy]，毫米）`,
              { tool: "patent_figure_project" },
            );
          }
          if (Math.abs(offset[0]) > MAX_CAD_LABEL_OFFSET_MM || Math.abs(offset[1]) > MAX_CAD_LABEL_OFFSET_MM) {
            throw new SatiToolRuntimeError(
              "invalid_tool_input",
              `${position}.label_offset_mm 绝对值不得超过 ${MAX_CAD_LABEL_OFFSET_MM}mm（收到 [${offset.join(", ")}]）`,
              { tool: "patent_figure_project" },
            );
          }
        }
        annotations.push({
          ref: annotation.ref,
          atMm: [annotation.at_mm[0]!, annotation.at_mm[1]!, annotation.at_mm[2]!],
          ...(offset === undefined ? {} : { labelOffsetMm: [offset[0]!, offset[1]!] as [number, number] }),
        });
      }

      const stepPath = isAbsolute(input.step_path) ? input.step_path : resolve(context.cwd, input.step_path);
      const outputDir =
        input.output_dir !== undefined
          ? isAbsolute(input.output_dir)
            ? input.output_dir
            : resolve(context.cwd, input.output_dir)
          : input.case_id !== undefined
            ? resolve(context.cwd, caseOutputsDir(input.case_id))
            : resolve(context.cwd, ".sati", "figures");

      // 能力探测 fail-closed：无 FreeCAD 不静默回退（CAD 图只能由几何投影得到）。
      let cmd = options.freecadCmd;
      let cmdSource = options.freecadCmd === undefined ? "" : "注入路径";
      if (cmd === undefined) {
        const probe = resolveFreecadCmd();
        if (probe === undefined) {
          throw new SatiToolRuntimeError(
            "tool_execution_failed",
            "未找到 FreeCAD 无头命令 freecadcmd：请安装 FreeCAD，或用 SATI_FREECAD_CMD 指定其路径" +
              "（本工具不静默回退其它渲染器——CAD 图只能由几何投影得到）",
            { tool: "patent_figure_project" },
          );
        }
        cmd = probe.cmd;
        cmdSource = probe.source;
      }

      try {
        const table = await projectStep({
          cmd,
          stepPath,
          view,
          ...(input.tolerance_mm === undefined ? {} : { toleranceMm: input.tolerance_mm }),
          ...(sectionOffset === undefined ? {} : { sectionOffsetMm: sectionOffset }),
          ...(options.runner === undefined ? {} : { runner: options.runner }),
        });
        // 几何级检查分两步：C1（边数）与 C5（剖切有效性）先于出图 → fail-closed；
        // C2/C3/C6–C9 依赖排版（缩放/剖面线/标注落位）→ 渲染后。
        const edgeFindings = checkCadProjection({ table, hiddenLines });
        const blocker = edgeFindings.find(finding => finding.severity === "fail");
        if (blocker !== undefined) {
          throw new SatiToolRuntimeError("tool_execution_failed", `投影结果不可交付：${blocker.message}`, {
            tool: "patent_figure_project",
            view,
          });
        }
        const render = renderCadSvg(table, {
          figureNo,
          jurisdiction,
          figureCount,
          hiddenLines,
          ...(annotations.length === 0 ? {} : { annotations }),
        });
        const findings = [
          ...edgeFindings,
          ...checkCadProjection({ table, render, hiddenLines }).filter(
            finding => finding.rule !== "C1" && finding.rule !== "C5",
          ),
        ];
        const layoutBlocker = findings.find(finding => finding.severity === "fail");
        if (layoutBlocker !== undefined) {
          throw new SatiToolRuntimeError("tool_execution_failed", `图幅不可交付：${layoutBlocker.message}`, {
            tool: "patent_figure_project",
            view,
          });
        }

        await mkdir(outputDir, { recursive: true });
        const svgPath = resolve(outputDir, `${input.output_name}-fig${figureNo}.svg`);
        await writeFile(svgPath, render.svg, "utf8");

        // 落版页（附加产物）：CAD 图以 mm 为坐标单位，故图内字高按 mm 直接传入。
        const caption = figureCaption(profile, figureNo, figureCount);
        const sheetText = sheet === undefined ? undefined : sheetNumberText(profile, sheet.index, sheet.total);
        const sheetField: FigureSidecarSheet | undefined =
          sheet === undefined || sheetText === undefined ? undefined : { ...sheet, text: sheetText };
        let layoutField: FigureSidecarLayout | undefined;
        let pagePath: string | undefined;
        if (input.fit_to_page === true) {
          const page = buildSubmissionPage({
            drawingSvg: render.svg,
            office: profile.office,
            ...(sheet === undefined ? {} : { sheetIndex: sheet.index, sheetTotal: sheet.total }),
            sourceCharHeightMm: 3.5,
          });
          pagePath = resolve(outputDir, `${input.output_name}-fig${figureNo}-page.svg`);
          await writeFile(pagePath, page.svg, "utf8");
          layoutField = {
            file: `${input.output_name}-fig${figureNo}-page.svg`,
            page_scale: page.metrics.pageScale,
            placed_width_mm: page.metrics.placedWidthMm,
            placed_height_mm: page.metrics.placedHeightMm,
            char_height_mm: page.metrics.charHeightMm,
            ...(page.warnings.length === 0 ? {} : { warnings: page.warnings }),
          };
        }

        // 图号 + 标记骨架 spec：CAD 图的画幅由投影几何决定（不由本模块布局决定），但**标记**
        // 是真实存在的图面内容 ⇒ 落进 nodes（label=标号、ref=标记），使 V2/V4 在定稿期可用
        const skeleton: FigureSpec = {
          figure_no: figureNo,
          kind: "block",
          nodes: annotations.map(annotation => ({
            id: `ref-${annotation.ref}`,
            label: String(annotation.ref),
            ref: annotation.ref,
          })),
          edges: [],
        };
        const sidecarPath = resolve(outputDir, figureSidecarFileName(input.output_name));
        await writeFile(
          sidecarPath,
          `${JSON.stringify(
            buildFigureSidecar({
              outputName: input.output_name,
              renderer: "cad",
              jurisdiction,
              documentKind,
              files: [
                {
                  figure_no: figureNo,
                  path: svgPath,
                  ...(caption === undefined ? {} : { caption }),
                  ...(sheetField === undefined ? {} : { sheet: sheetField }),
                  ...(layoutField === undefined ? {} : { layout: layoutField }),
                  geometry: {
                    source: "cad",
                    view,
                    scale: render.scale,
                    width_mm: render.widthMm,
                    height_mm: render.heightMm,
                    hidden_lines: hiddenLines,
                    ...(table.section === undefined
                      ? {}
                      : {
                          section: {
                            offset_mm: table.section.offset_mm,
                            cut_faces: render.cutFaces,
                            hatch_segments: render.hatchSegments,
                          },
                        }),
                    ...(annotations.length === 0
                      ? {}
                      : {
                          ref_numerals: annotations.map(annotation => annotation.ref),
                        }),
                    findings,
                  },
                },
              ],
              figures: [skeleton],
              check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
              // 文本侧规则在投影期不适用（无说明书文本），核验由附图门在定稿期跑
              skipTextRules: true,
            }),
            null,
            2,
          )}\n`,
          "utf8",
        );

        const lines: string[] = [
          `已投影 ${view} 视图（FreeCAD 无头，命令来源: ${cmdSource}）：`,
          `- 图${figureNo}: ${svgPath}`,
          `- 几何范围 ${table.edges.length} 条投影边（可见 ${render.visibleEdges} / 隐藏 ${render.hiddenEdges}）`,
          `- 纸面尺寸 ${render.widthMm.toFixed(1)}×${render.heightMm.toFixed(1)}mm（适配缩放 ${(render.scale * 100).toFixed(0)}%，` +
            `${profile.office} 可印区 ${area.widthMm.toFixed(1)}×${area.heightMm.toFixed(1)}mm 内）`,
          `- 图号：${caption === undefined ? `本案仅一幅附图，按 ${profile.office} 档案不标注图号` : `${caption}（标注在图下方）`}`,
          ...(sheetText === undefined ? [] : [`- 附图页页码：本图页写作 ${sheetText}`]),
          ...(pagePath === undefined ? [] : [`- 提交落版页（A4 整页）: ${pagePath}`]),
          ...(table.section === undefined
            ? []
            : [
                `- 全剖视图：剖切面位于 ${table.section.offset_mm}mm，剖切面 ${render.cutFaces} 个、剖面线 ${render.hatchSegments} 段`,
              ]),
          ...(annotations.length === 0
            ? []
            : [
                `- 附图标记 ${annotations.length} 个（模型坐标锚点 + 引线）：${annotations.map(a => a.ref).join("、")}`,
              ]),
          `- 附图 sidecar: ${sidecarPath}`,
          "",
          "几何级检查：",
          ...findings.map(
            finding =>
              `- [${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}` +
              (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
          ),
          "",
          "说明：本工具不产几何；剖面线为 45° 细实线（纸面等间距）；旋转剖/阶梯剖/局部剖未做。" +
            "附图标记的锚点由调用方按模型坐标给出，图面标号位置可经 label_offset_mm 指定。",
        ];

        return {
          content: [
            { type: "text", text: lines.join("\n") },
            {
              type: "file" as const,
              path: svgPath,
              mimeType: "image/svg+xml",
              description: `CAD 投影图 图${figureNo}`,
            },
            ...(pagePath === undefined
              ? []
              : [
                  {
                    type: "file" as const,
                    path: pagePath,
                    mimeType: "image/svg+xml",
                    description: `CAD 投影落版页 图${figureNo}`,
                  },
                ]),
            {
              type: "file" as const,
              path: sidecarPath,
              mimeType: "application/json",
              description: "CAD figure sidecar",
            },
          ],
        };
      } catch (err) {
        if (err instanceof SatiToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_project 执行失败: ${message}`, {
          tool: "patent_figure_project",
          view,
        });
      }
    },
  };
}
