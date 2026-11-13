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
 *
 * P2.5（issue #646）：execute 的 411 行按「入参校验 → 投影与几何检查 → 产物装配 →
 * 报告」分层，校验与装配收敛到模块级函数（标注校验 / FreeCAD 探测 / 产物落盘 /
 * 报告与 data/content 构造）；与 generate 逐字重复的入参管线收进 patentFigureShared.ts。
 */

import { isAbsolute, resolve } from "node:path";
import {
  CAD_VIEWS,
  CadArtifactError,
  CadProjectionError,
  findingForLeaderPlacementError,
  isCadSectionView,
  isCadView,
  isLeaderPlacementError,
  printableArea,
  profileForJurisdiction,
  projectCadViews,
  resolveCadViewPlan,
  resolveFreecadCmd,
  sheetNumberText,
  writeCadArtifacts,
  type CadProjectionOutcome,
  type CadRefAnnotation,
  type CadRunner,
  type CadView,
  type DocumentKind,
  type FigureSidecarSheetLayout,
  type InkscapeProbe,
  type Jurisdiction,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { FIGURE_FINDING_SCHEMA, JURISDICTIONS, toFigureCount, toJurisdiction } from "./patentFigureSchema.js";
import {
  assertFigureOutputName,
  resolveFigureOutputDir,
  resolveInkscapeProbe,
  resolveSubmissionStyle,
  toDocumentKind,
  validateSheetArgs,
} from "./patentFigureShared.js";

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
  /** 本次要投影的视图集（per-call；缺省取部署级 env，env 缺省单视图）。 */
  views?: string[];
  /** 落版参数（per-call；缺省取部署级 env）。 */
  submission?: {
    rotate_deg?: number;
    caption_font_mm?: number;
    caption_gap_mm?: number;
    sheet_font_mm?: number;
  };
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

/** 几何级检查发现（编排层返回的条目）。 */
type CadFinding = CadProjectionOutcome["views"][number]["findings"][number];

/** 产物装配结果（报告与 data/content 构造的输入）。 */
type ProjectArtifacts = {
  /** 各视图的 SVG 路径（顺序与视图一致）。 */
  svgPaths: string[];
  pagePath: string | undefined;
  /** 拼版页路径（多视图 + 落版时出现；单视图不产）。 */
  sheetPath: string | undefined;
  /** 拼版页摘要（网格形状、统一缩放、字高核验）。 */
  sheetLayout: FigureSidecarSheetLayout | undefined;
  caption: string | undefined;
  /** manifest 路径（视图 → 文件 → 几何事实 / 件号归属）。 */
  manifestPath: string;
  sidecarPath: string;
};

/** 剖切位置校验：仅轴对齐视图可剖（rotate/stepped/local section 不做），且须为有限数字。 */
function validateSectionOffset(sectionOffset: number | undefined, view: CadView, tool: string): number | undefined {
  if (sectionOffset === undefined) return undefined;
  if (!isCadSectionView(view)) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `视图 ${view} 不能剖切：剖切要求轴对齐视图（front/back/left/right/top/bottom），轴测图无"剖切面"语义`,
      { tool },
    );
  }
  if (!Number.isFinite(sectionOffset)) {
    throw new SatiToolRuntimeError("invalid_tool_input", `section_offset_mm 应为有限数字`, {
      tool,
    });
  }
  return sectionOffset;
}

/**
 * 附图标记标注逐项校验（锚点须是三元有限数组，偏移须在可交付范围内，ref 不得重复）。
 * ref → 首次出现的下标：同一附图标记只应标注一处（render-cad 用 ref 当引线择位的 id，
 * 重复会让两个标号落在同一点、先出现的锚点引线消失，而落位报告零告警）。
 */
function validateProjectAnnotations(
  rawAnnotations: PatentFigureProjectAnnotation[] | undefined,
  tool: string,
): CadRefAnnotation[] {
  const annotations: CadRefAnnotation[] = [];
  const raw = rawAnnotations ?? [];
  if (raw.length > MAX_CAD_ANNOTATIONS) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `annotations 至多 ${MAX_CAD_ANNOTATIONS} 项（收到 ${raw.length} 项）`,
      { tool },
    );
  }
  const refFirstIndex = new Map<number, number>();
  for (const [index, annotation] of raw.entries()) {
    const position = `annotations[${index}]`;
    if (!Number.isInteger(annotation.ref) || annotation.ref <= 0 || annotation.ref > 999) {
      throw new SatiToolRuntimeError("invalid_tool_input", `${position}.ref 应为 1–999 的整数`, {
        tool,
      });
    }
    const firstIndex = refFirstIndex.get(annotation.ref);
    if (firstIndex !== undefined) {
      throw new SatiToolRuntimeError(
        "invalid_tool_input",
        `${position}.ref 与 annotations[${firstIndex}].ref 重复（同为 ${annotation.ref}）：` +
          "同一附图标记只应标注一处——重复会让两个标号落在同一点、先出现的引线消失（细则第 21 条：标记应一致）",
        { tool, ref: annotation.ref },
      );
    }
    refFirstIndex.set(annotation.ref, index);
    if (
      !Array.isArray(annotation.at_mm) ||
      annotation.at_mm.length !== 3 ||
      !annotation.at_mm.every(value => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new SatiToolRuntimeError(
        "invalid_tool_input",
        `${position}.at_mm 应为三个有限数字（模型坐标 [x, y, z]，毫米）`,
        { tool },
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
          { tool },
        );
      }
      if (Math.abs(offset[0]) > MAX_CAD_LABEL_OFFSET_MM || Math.abs(offset[1]) > MAX_CAD_LABEL_OFFSET_MM) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `${position}.label_offset_mm 绝对值不得超过 ${MAX_CAD_LABEL_OFFSET_MM}mm（收到 [${offset.join(", ")}]）`,
          { tool },
        );
      }
    }
    annotations.push({
      ref: annotation.ref,
      atMm: [annotation.at_mm[0]!, annotation.at_mm[1]!, annotation.at_mm[2]!],
      ...(offset === undefined ? {} : { labelOffsetMm: [offset[0]!, offset[1]!] as [number, number] }),
    });
  }
  return annotations;
}

/** 能力探测 fail-closed：无 FreeCAD 不静默回退（CAD 图只能由几何投影得到）。 */
function probeFreecadCommand(
  options: CreatePatentFigureProjectToolOptions,
  tool: string,
): { cmd: string; cmdSource: string } {
  if (options.freecadCmd !== undefined) {
    return { cmd: options.freecadCmd, cmdSource: "注入路径" };
  }
  const probe = resolveFreecadCmd();
  if (probe === undefined) {
    throw new SatiToolRuntimeError(
      "setup_required",
      "未找到 FreeCAD 无头命令 freecadcmd：请安装 FreeCAD，或用 SATI_FREECAD_CMD 指定其路径" +
        "（本工具不静默回退其它渲染器——CAD 图只能由几何投影得到）",
      { tool },
    );
  }
  return { cmd: probe.cmd, cmdSource: probe.source };
}

/**
 * 产物装配：逐视图 SVG 落盘 → 可选落版页 → 可选文本转路径 → manifest → sidecar。
 *
 * 装配逻辑落在 `cad/artifacts.ts`（本仓 CAD 域的算法不放工具层，工具层只留 env 解析与
 * 调用）；顺序是契约的一部分：先探测后落盘的 fail-loud 语义在入参阶段已完成；转路径在
 * 全部图形落盘之后、sidecar 之前——sidecar 记录"已转路径"这一事实。
 */
async function writeProjectArtifacts(args: {
  outputDir: string;
  outputName: string;
  figureNo: number;
  figureCount: number;
  fitToPage: boolean | undefined;
  outcome: CadProjectionOutcome;
  jurisdiction: Jurisdiction;
  documentKind: DocumentKind | undefined;
  profile: OfficeProfile;
  sheet: { index: number; total: number } | undefined;
  sheetText: string | undefined;
  inkscape: InkscapeProbe | undefined;
  hiddenLines: boolean;
  stepPath: string;
  tool: string;
  /** 落版样式（per-call 优先 / env 兜底）。 */
  submissionStyle?: {
    readonly rotateDeg?: number;
    readonly captionFontMm?: number;
    readonly captionGapMm?: number;
    readonly sheetFontMm?: number;
  };
}): Promise<ProjectArtifacts> {
  const artifacts = await writeCadArtifacts({
    outputDir: args.outputDir,
    outputName: args.outputName,
    figureNo: args.figureNo,
    figureCount: args.figureCount,
    fitToPage: args.fitToPage,
    jurisdiction: args.jurisdiction,
    documentKind: args.documentKind,
    profile: args.profile,
    ...(args.sheet === undefined ? {} : { sheet: args.sheet }),
    ...(args.sheetText === undefined ? {} : { sheetText: args.sheetText }),
    ...(args.inkscape === undefined ? {} : { inkscape: args.inkscape }),
    hiddenLines: args.hiddenLines,
    outcome: args.outcome,
    stepPath: args.stepPath,
    tool: args.tool,
    ...(args.submissionStyle === undefined ? {} : { submissionStyle: args.submissionStyle }),
  });
  return {
    svgPaths: artifacts.svgPaths,
    pagePath: artifacts.pagePath,
    sheetPath: artifacts.sheetPath,
    sheetLayout: artifacts.sheetLayout,
    caption: artifacts.caption,
    manifestPath: artifacts.manifestPath,
    sidecarPath: artifacts.sidecarPath,
  };
}

/**
 * 几何级发现去重（按 规则 + 文案）。
 *
 * 多视图时同一条判据（如 C14 锚点不落在零件上）在各视图重复出现，而它的成因与视图无关
 * ⇒ data 里只留一条（报告文本仍逐视图列出，视图名在文案里）。
 */
function dedupeFindings(findings: readonly CadFinding[]): CadFinding[] {
  const seen = new Set<string>();
  const unique: CadFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.rule}|${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

/**
 * 报告文本（人能直接照做的行式摘要；检查发现逐条列出，择位降级显式报出）。
 *
 * 多视图时逐视图一段（几何、剖面线方向、附图标记与件号归属），末尾给出 manifest 路径
 * ——"件号 ↔ 零件 ↔ 锚点"的完整对应在 manifest 里，报告只给摘要。
 */
function buildProjectResultLines(args: {
  outcome: CadProjectionOutcome;
  figureNo: number;
  svgPaths: string[];
  pagePath: string | undefined;
  sheetPath: string | undefined;
  sheetLayout: FigureSidecarSheetLayout | undefined;
  manifestPath: string;
  profile: OfficeProfile;
  area: ReturnType<typeof printableArea>;
  caption: string | undefined;
  sheetText: string | undefined;
  sidecarPath: string;
  cmdSource: string;
  viewSource: string;
}): string[] {
  const { outcome, figureNo, svgPaths, pagePath, sheetPath, sheetLayout, manifestPath, profile, area, caption } = args;
  const { sheetText, sidecarPath, cmdSource, viewSource } = args;
  const lines: string[] = [
    `已投影 ${outcome.views.length} 个视图（FreeCAD 无头，命令来源: ${cmdSource}；视图集: ${viewSource}）：`,
  ];
  outcome.views.forEach((view, index) => {
    const render = view.render;
    lines.push(`- 视图 ${view.view}（图${figureNo}）: ${svgPaths[index] ?? ""}`);
    lines.push(
      `  - 几何 ${view.table.edges.length} 条投影边（可见 ${render.visibleEdges} / 隐藏 ${render.hiddenEdges}），` +
        `纸面 ${render.widthMm.toFixed(1)}×${render.heightMm.toFixed(1)}mm（适配缩放 ${(render.scale * 100).toFixed(0)}%，` +
        `${profile.office} 可印区 ${area.widthMm.toFixed(1)}×${area.heightMm.toFixed(1)}mm 内）`,
    );
    if (view.table.section !== undefined) {
      lines.push(
        `  - 全剖视图：剖切面位于 ${view.table.section.offset_mm}mm，剖切面 ${render.cutFaces} 个、` +
          `剖面线 ${render.hatchSegments} 段（方向 ${render.hatchAnglesDeg.map(angle => `${angle}°`).join(" / ")}，相邻件方向相反）`,
      );
    }
    if (view.annotations.length > 0) {
      lines.push(`  - 附图标记 ${view.annotations.length} 个：${view.annotations.map(item => item.ref).join("、")}`);
      // 择位降级（无可用引线落位 ⇒ 标号压在图上）必须显式报出：C11 是机器可读的
      // 检查项，这里再给一句人能直接照做的说明
      for (const warning of render.labelWarnings) lines.push(`  - 标注择位降级：${warning}`);
    }
    const owned = view.bindings.filter(binding => binding.partIndex !== null);
    if (owned.length > 0) {
      lines.push(
        `  - 件号归属（件号→零件序号）：${owned
          .map(binding => `${binding.ref}→零件 ${binding.partIndex}${binding.source === "auto" ? "（自动锚点）" : ""}`)
          .join("、")}`,
      );
    }
    for (const notice of view.notices) lines.push(`  - 口径说明：${notice}`);
  });
  lines.push(
    `- 图号：${caption === undefined ? `本案仅一幅附图，按 ${profile.office} 档案不标注图号` : `${caption}（标注在图下方）`}`,
  );
  if (sheetText !== undefined) lines.push(`- 附图页页码：本图页写作 ${sheetText}`);
  if (pagePath !== undefined) lines.push(`- 提交落版页（A4 整页）: ${pagePath}`);
  if (sheetPath !== undefined && sheetLayout !== undefined) {
    lines.push(
      `- 提交拼版页（A4 整页，${sheetLayout.columns} 列 × ${sheetLayout.rows} 行共 ${sheetLayout.cells} 格，` +
        `各格统一缩放 ${(sheetLayout.page_scale * 100).toFixed(0)}%，格 ${sheetLayout.cell_width_mm.toFixed(1)}×` +
        `${sheetLayout.cell_height_mm.toFixed(1)}mm）: ${sheetPath}`,
    );
    // 字高核验：低于法域下限必须**报出来**（不静默、不假装通过）。
    const limit = sheetLayout.min_char_height_mm;
    const basis = sheetLayout.min_char_height_basis === "statute" ? "条文下限" : "实践下限";
    const limitText = limit === undefined ? "（该法域档案未登记字高下限）" : `（下限 ${limit.toFixed(2)}mm，${basis}）`;
    lines.push(
      `- 拼版后图内字高 ${sheetLayout.char_height_mm.toFixed(2)}mm${limitText}` +
        ` → ${sheetLayout.char_height_compliant ? "达标" : "**不达标**"}`,
    );
    for (const warning of sheetLayout.warnings ?? []) lines.push(`  - 拼版告警：${warning}`);
  }
  lines.push(`- 结构图 manifest（视图 → 文件 → 零件几何事实 / 件号归属）: ${manifestPath}`);
  lines.push(`- 附图 sidecar: ${sidecarPath}`);
  lines.push("");
  lines.push("几何级检查：");
  for (const view of outcome.views) {
    for (const finding of view.findings) {
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${finding.rule}（${view.view}）: ${finding.message}` +
          (finding.evidence ? `\n  ${finding.evidence.join("\n  ")}` : ""),
      );
    }
  }
  lines.push("");
  lines.push(
    "说明：本工具不产几何；剖面线为细实线（纸面等间距，相邻零件方向相反以示区分，GB/T 4457.5）；" +
      "旋转剖/阶梯剖/局部剖未做。附图标记的锚点由调用方按模型坐标给出（锚点落在哪个零件由几何判定，" +
      "不落则报 C14），图面标号位置可经 label_offset_mm 指定。",
  );
  return lines;
}

export function createPatentFigureProjectTool(
  options: CreatePatentFigureProjectToolOptions = {},
): SatiToolDefinition<PatentFigureProjectInput> {
  return {
    name: "patent_figure_project",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "figure_no",
        "output_name",
        "view",
        "svg_path",
        "sidecar_path",
        "command_source",
        "scale",
        "width_mm",
        "height_mm",
        "geometry_findings",
      ],
      properties: {
        figure_no: { type: "integer" },
        output_name: { type: "string" },
        view: { type: "string", enum: [...CAD_VIEWS] },
        svg_path: { type: "string" },
        svg_paths: {
          type: "array",
          items: { type: "string" },
          description: "多视图时各视图的 SVG 路径（单视图时缺省）",
        },
        page_path: { type: "string", description: "提交落版页（开启时出现）" },
        sheet_path: { type: "string", description: "提交拼版页（多视图共页的 A4 整页；开启落版且多视图时出现）" },
        sidecar_path: { type: "string" },
        manifest_path: { type: "string", description: "结构图 manifest（视图 / 零件几何事实 / 件号归属）" },
        command_source: { type: "string", description: "FreeCAD 可执行来源（env 覆盖 / 平台候选）" },
        scale: { type: "number", description: "适配 A4 可印区的缩放系数" },
        width_mm: { type: "number" },
        height_mm: { type: "number" },
        visible_edges: { type: "integer" },
        hidden_edges: { type: "integer" },
        hidden_lines: { type: "boolean" },
        caption: { type: "string", description: "图号标注（单幅且 pct/us 时不出现）" },
        section: {
          type: "object",
          additionalProperties: false,
          required: ["offset_mm", "cut_faces", "hatch_segments"],
          properties: {
            offset_mm: { type: "number" },
            cut_faces: { type: "integer" },
            hatch_segments: { type: "integer" },
          },
          description: "全剖视图剖切参数（非剖视时缺省）",
        },
        ref_numerals: { type: "array", items: { type: "integer" }, description: "图面已标注的附图标记" },
        geometry_findings: { type: "array", items: FIGURE_FINDING_SCHEMA, description: "几何级检查（C1–C12）" },
      },
    },
    aliases: ["PatentFigureProject", "figure_project"],
    title: "Project 3D Model to Patent Figure",
    description:
      "Project a STEP/3D model into a patent-style figure (black-and-white SVG, hidden-line removal, " +
      "orthographic projection) with a local headless FreeCAD. Views: front/back/left/right/top/bottom/iso. " +
      "section_offset_mm produces a full section view; annotations place reference numerals. Returns the SVG " +
      "plus a sidecar. Requires FreeCAD (SATI_FREECAD_CMD); missing install fails closed.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["step_path", "output_name", "view"],
      properties: {
        step_path: { type: "string", description: "STEP file path." },
        output_name: { type: "string", description: "Output base name." },
        view: { type: "string", enum: [...CAD_VIEWS], description: "Projection view (iso = isometric)." },
        figure_no: { type: "number", description: "Figure number (default 1)." },
        hidden_lines: {
          type: "boolean",
          description: "Draw hidden lines (default false).",
        },
        section_offset_mm: {
          type: "number",
          description: "Section plane offset in model mm (axis views only).",
        },
        annotations: {
          type: "array",
          description: "Reference-numeral anchors (model mm).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "at_mm"],
            properties: {
              ref: { type: "integer", description: "Reference numeral." },
              at_mm: {
                type: "array",
                description: "Anchor [x,y,z] in model mm.",
                items: { type: "number" },
              },
              label_offset_mm: {
                type: "array",
                description: "Label offset [dx,dy] in mm.",
                items: { type: "number" },
              },
            },
          },
        },
        case_id: { type: "string", description: "Case id." },
        output_dir: { type: "string", description: "Output dir." },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description: "cn|us|pct.",
        },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "invention / utility (sidecar V9).",
        },
        tolerance_mm: { type: "number", description: "Projection tolerance in mm (default 0.5)." },
        figure_count: {
          type: "integer",
          minimum: 1,
          description: "Total figures in case.",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "Sheet index (paired with sheet_total).",
        },
        sheet_total: { type: "integer", minimum: 1, description: "Total sheets." },
        fit_to_page: {
          type: "boolean",
          description: "Also produce a print page SVG.",
        },
        views: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: [...CAD_VIEWS] },
          description: "Views to project in one run (env fallback).",
        },
        submission: {
          type: "object",
          additionalProperties: false,
          properties: {
            rotate_deg: { type: "integer", enum: [0, 90, 180, 270] },
            caption_font_mm: { type: "number" },
            caption_gap_mm: { type: "number" },
            sheet_font_mm: { type: "number" },
          },
          description: "Per-call page params (env fallback).",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const tool = "patent_figure_project";
      // —— 入参校验与归一（全部在探测/落盘之前；fail-loud 顺序即旧实现顺序） ——
      if (!isCadView(input.view)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `非法 view "${input.view}"（可用: ${CAD_VIEWS.join(", ")}）`,
          { tool },
        );
      }
      const view: CadView = input.view;
      // per-call 视图集的合法性**先**于视图计划解析报出：入参写错是调用方的问题
      //（invalid_tool_input），不能与部署配置写错（setup_required）混为一谈。
      if (input.views !== undefined) {
        for (const name of input.views) {
          if (!isCadView(name)) {
            throw new SatiToolRuntimeError(
              "invalid_tool_input",
              `非法 views 项 "${name}"（可用: ${CAD_VIEWS.join(", ")}）`,
              { tool },
            );
          }
        }
      }
      // 落版参数：部署级 env 打底，per-call 入参优先。非法值必须在落盘前报错。
      const submissionStyle = resolveSubmissionStyle(process.env, tool, {
        ...(input.submission?.rotate_deg === undefined ? {} : { rotateDeg: input.submission.rotate_deg }),
        ...(input.submission?.caption_font_mm === undefined ? {} : { captionFontMm: input.submission.caption_font_mm }),
        ...(input.submission?.caption_gap_mm === undefined ? {} : { captionGapMm: input.submission.caption_gap_mm }),
        ...(input.submission?.sheet_font_mm === undefined ? {} : { sheetFontMm: input.submission.sheet_font_mm }),
      });
      assertFigureOutputName(input.output_name, tool);
      const figureNo =
        Number.isInteger(input.figure_no) && (input.figure_no ?? 0) > 0 ? (input.figure_no as number) : 1;
      const jurisdiction: Jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const area = printableArea(profile);
      const figureCount = toFigureCount(input.figure_count, 1);
      const sheet = validateSheetArgs(input, tool);
      const documentKind = toDocumentKind(input.document_kind);
      const inkscape = resolveInkscapeProbe(tool);
      const hiddenLines = input.hidden_lines === true;
      const sectionOffset = validateSectionOffset(input.section_offset_mm, view, tool);
      const annotations = validateProjectAnnotations(input.annotations, tool);
      const stepPath = isAbsolute(input.step_path) ? input.step_path : resolve(context.cwd, input.step_path);
      const outputDir = resolveFigureOutputDir(input, context.cwd);
      const { cmd, cmdSource } = probeFreecadCommand(options, tool);

      try {
        // 视图计划（部署级 env）：view 入参仍是主视图，env 追加其余视图；env 未设置 ⇒ 单视图。
        let plan;
        try {
          plan = resolveCadViewPlan(process.env, view, input.views);
        } catch (err) {
          // 部署配置写错（非法视图名 / 非法布尔取值）⇒ 不是调用方的入参问题，报 setup_required。
          throw new SatiToolRuntimeError(
            "setup_required",
            `部署配置非法：${err instanceof Error ? err.message : String(err)}`,
            { tool },
          );
        }
        const outcome = await projectCadViews({
          cmd,
          stepPath,
          views: plan.views,
          ...(sectionOffset === undefined ? {} : { sectionOffsetMm: sectionOffset }),
          ...(input.tolerance_mm === undefined ? {} : { toleranceMm: input.tolerance_mm }),
          annotations,
          autoAnchors: plan.autoAnchors,
          figureNo,
          jurisdiction,
          figureCount,
          hiddenLines,
          ...(options.runner === undefined ? {} : { runner: options.runner }),
        });
        const primary = outcome.primary;
        const sheetText = sheet === undefined ? undefined : sheetNumberText(profile, sheet.index, sheet.total);
        const artifacts = await writeProjectArtifacts({
          outputDir,
          outputName: input.output_name,
          figureNo,
          figureCount,
          fitToPage: input.fit_to_page,
          outcome,
          jurisdiction,
          documentKind,
          profile,
          sheet,
          sheetText,
          inkscape,
          hiddenLines,
          stepPath,
          tool,
          submissionStyle,
        });
        const lines = buildProjectResultLines({
          outcome,
          figureNo,
          svgPaths: artifacts.svgPaths,
          pagePath: artifacts.pagePath,
          sheetPath: artifacts.sheetPath,
          sheetLayout: artifacts.sheetLayout,
          manifestPath: artifacts.manifestPath,
          profile,
          area,
          caption: artifacts.caption,
          sheetText,
          sidecarPath: artifacts.sidecarPath,
          cmdSource,
          viewSource: plan.source,
        });
        const data = {
          figure_no: figureNo,
          output_name: input.output_name,
          view,
          svg_path: artifacts.svgPaths[0] ?? "",
          ...(artifacts.svgPaths.length > 1 ? { svg_paths: artifacts.svgPaths } : {}),
          ...(artifacts.pagePath === undefined ? {} : { page_path: artifacts.pagePath }),
          ...(artifacts.sheetPath === undefined ? {} : { sheet_path: artifacts.sheetPath }),
          sidecar_path: artifacts.sidecarPath,
          manifest_path: artifacts.manifestPath,
          command_source: cmdSource,
          scale: primary.render.scale,
          width_mm: primary.render.widthMm,
          height_mm: primary.render.heightMm,
          visible_edges: primary.render.visibleEdges,
          hidden_edges: primary.render.hiddenEdges,
          hidden_lines: hiddenLines,
          ...(artifacts.caption === undefined ? {} : { caption: artifacts.caption }),
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
            : { ref_numerals: primary.annotations.map(annotation => annotation.ref) }),
          geometry_findings: dedupeFindings(outcome.views.flatMap(view => view.findings)),
        };

        return {
          data,
          content: [
            { type: "text", text: lines.join("\n") },
            ...artifacts.svgPaths.map((path, index) => ({
              type: "file" as const,
              path,
              mimeType: "image/svg+xml",
              description: `CAD 投影图 图${figureNo}（${outcome.views[index]?.view ?? "?"}）`,
            })),
            ...(artifacts.pagePath === undefined
              ? []
              : [
                  {
                    type: "file" as const,
                    path: artifacts.pagePath,
                    mimeType: "image/svg+xml",
                    description: `CAD 投影落版页 图${figureNo}`,
                  },
                ]),
            ...(artifacts.sheetPath === undefined
              ? []
              : [
                  {
                    type: "file" as const,
                    path: artifacts.sheetPath,
                    mimeType: "image/svg+xml",
                    description: `CAD 投影拼版页 图${figureNo}（多视图共页）`,
                  },
                ]),
            {
              type: "file" as const,
              path: artifacts.manifestPath,
              mimeType: "application/json",
              description: "CAD 结构图 manifest（视图 / 零件 / 件号归属）",
            },
            {
              type: "file" as const,
              path: artifacts.sidecarPath,
              mimeType: "application/json",
              description: "CAD figure sidecar",
            },
          ],
        };
      } catch (err) {
        if (err instanceof SatiToolRuntimeError) throw err;
        if (err instanceof CadProjectionError) {
          // 几何不可交付：消息保留"投影结果不可交付 / 图幅不可交付"字样（既有契约），
          // 并把触发失败的检查规则带进详情，便于调用方定位。
          throw new SatiToolRuntimeError("tool_execution_failed", err.message, {
            tool,
            view,
            rule: err.findings.find(finding => finding.severity === "fail")?.rule,
          });
        }
        if (err instanceof CadArtifactError) {
          // 落盘阶段失败：保留路径与原因（既有契约：转路径失败要报出是哪个文件）
          throw new SatiToolRuntimeError("tool_execution_failed", err.message, {
            tool,
            view,
            path: err.path,
            ...(err.reason === undefined ? {} : { reason: err.reason }),
          });
        }
        if (isLeaderPlacementError(err)) {
          const finding = findingForLeaderPlacementError(err);
          throw new SatiToolRuntimeError("tool_execution_failed", finding.message, {
            tool,
            view,
            rule: finding.rule,
            unplaceable_ids: [...err.unplaceableIds],
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_project 执行失败: ${message}`, {
          tool,
          view,
        });
      }
    },
  };
}
