/**
 * patent_figure_generate — 从结构化 FigureSpec 确定性渲染专利附图（SVG / A4 HTML）。
 *
 * LLM 只产结构化节点/边/附图标记，不产图形；黑白线条合规（审查指南 2023 一部
 * 一章 4.3/4.6）是渲染器构造期不变式。生成后自动运行结构校验（V1/V4/V5/V7/V8/V9；
 * V2/V3 需说明书文本，属 patent_figure_check 职责）与图面渲染复核（RC1–RC9），
 * 并以同目录既有 sidecar 核对跨调用的图号/标号占用；发现随结果返回（缺省不阻断，
 * 档位见 `SATI_FIGURE_RENDER_GATE`）。format=html/both 时另产 A4 打印版式
 * 单文件 HTML（PDF 经既有 Chromium 打印管线从该 HTML 产出）。
 *
 * 默认注册（createBuiltinRegistry `patentFigure: false` 可排除；排除会改变工具集
 * 摘要，需重录 deepseek-v4-flash-basic fixture）。
 *
 * 落盘产物：`<name>-fig<N>.svg`（每幅）+ `<name>-figures.json`（sidecar：完整
 * FigureSpec 与生成期核验快照，供下游在有说明书文本时零信息损耗重跑规则，
 * 见 figuregen/sidecar.ts）+ 可选 `<name>-figures.html`。
 *
 * 渲染器选择走 SATI_FIGURE_RENDERER 环境变量（builtin 默认 / graphviz 系统 dot /
 * graphviz-wasm 打包 WASM，后两者均为复杂大图可选增强）：环境变量而非 inputSchema
 * 选项，避免动 llm-replay 请求键。默认保持 builtin——改默认会使全部快照与既有行为突变。
 *
 * P2.5（issue #646）：execute 的 322 行按「入参校验 → 渲染管线 → 产物装配 → 报告」
 * 分层；渲染器解析与逐幅落盘收敛到模块级函数，与 project/check 逐字重复的入参管线
 * 收进 patentFigureShared.ts。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  FIGURE_RENDERER_ENV,
  applyVisibleNumerals,
  buildFigureSidecar,
  checkFigures,
  createWasmDotRunner,
  exportSvgTextToPath,
  figureCaption,
  measureSvgPaperSize,
  profileForJurisdiction,
  readFigureSidecars,
  renderFigureSvg,
  renderFigureSvgWithGraphviz,
  renderFiguresHtml,
  resolveDotBinary,
  sheetNumberText,
  shouldRenderCaption,
  sourceCharHeightMm,
  writeFigureSidecar,
  writeSubmissionPageArtifact,
  type DotRunner,
  type FigureSpec,
  type InkscapeProbe,
  type Jurisdiction,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import {
  buildDeliverableManifestForOutput,
  buildNumeralMap,
  normalizeFigureNumerals,
  collectComplianceFindings,
  writeFigureIndex,
  type RenderedFigureFile,
} from "./patentFigureOutput.js";
import { buildGenerateReportLines } from "./patentFigureReport.js";
import {
  crossCallReview,
  resolveMinSheetFillRatio,
  resolveRenderGate,
  reviewRenderedFigures,
  type FigureCheck,
} from "./patentFigureReview.js";
import {
  assertFigurePayloads,
  FIGURE_ARTIFACT_SCHEMA,
  FIGURE_FINDING_SCHEMA,
  FIGURE_INPUT_SCHEMA_REF,
  JURISDICTIONS,
  toFigureCount,
  toJurisdiction,
} from "./patentFigureSchema.js";
import {
  assertBuiltinRenderableFigures,
  assertFigureOutputName,
  resolveFigureOutputDir,
  resolveAutoNumbering,
  resolveInkscapeProbe,
  resolveSubmissionStyle,
  toDocumentKind,
  validateSheetArgs,
  type SubmissionStyleOptions,
} from "./patentFigureShared.js";

export type PatentFigureGenerateInput = {
  figures: FigureSpec[];
  output_name: string;
  case_id?: string;
  output_dir?: string;
  document_kind?: string;
  invention_name?: string;
  brief?: boolean;
  format?: string;
  jurisdiction?: string;
  figure_count?: number;
  sheet_index?: number;
  sheet_total?: number;
  fit_to_page?: boolean;
  /** 自动发号开关（per-call；缺省取部署级 env，env 缺省 off）。 */
  auto_numbering?: boolean;
  /** 自动发号起点（per-call；缺省按图号算 100 系列）。 */
  numeral_start?: number;
  /** 自动发号步进（per-call；缺省 2）。 */
  numeral_step?: number;
  /** 保留号（字符串形态；跳过不分配）。 */
  reserved?: string[];
  /** 族标识：本次调用的图共享一个连续标号系列。 */
  figure_family?: string;
  /** 落版参数（per-call；缺省取部署级 env）。 */
  submission?: {
    rotate_deg?: number;
    caption_font_mm?: number;
    caption_gap_mm?: number;
    sheet_font_mm?: number;
  };
};

const FORMATS: readonly string[] = ["svg", "html", "both"];

/**
 * 渲染器选择：SATI_FIGURE_RENDERER=graphviz 走本机 dot，=graphviz-wasm 走打包 WASM
 * （均复杂大图可选增强）；缺省 builtin。不做成 inputSchema 选项是因为默认注册工具的
 * schema 参与 llm-replay 请求键，任何变更都须重录 fixture（见 figuregen 决策记录）。
 */
type FigureRenderer = "builtin" | "graphviz" | "graphviz-wasm";

function resolveFigureRenderer(env: NodeJS.ProcessEnv = process.env): FigureRenderer {
  const value = (env[FIGURE_RENDERER_ENV] ?? "").trim();
  if (value === "" || value === "builtin") {
    return "builtin";
  }
  if (value === "graphviz") {
    return "graphviz";
  }
  if (value === "graphviz-wasm") {
    return "graphviz-wasm";
  }
  throw new SatiToolRuntimeError(
    "invalid_tool_input",
    `非法 ${FIGURE_RENDERER_ENV} "${value}"（可用: builtin, graphviz, graphviz-wasm）`,
    { tool: "patent_figure_generate" },
  );
}

/** 渲染管线：环境变量解析 + 渲染器依赖探测 + 逐幅渲染闭包。 */
function resolveRenderPipeline(
  figures: FigureSpec[],
  jurisdiction: Jurisdiction,
  figureCount: number,
  tool: string,
): { renderer: FigureRenderer; renderOne: (figure: FigureSpec) => Promise<string> } {
  const renderer = resolveFigureRenderer();
  let dotPath: string | null = null;
  let wasmRunner: DotRunner | undefined;
  if (renderer === "graphviz") {
    dotPath = resolveDotBinary();
    if (dotPath === null) {
      throw new SatiToolRuntimeError(
        "setup_required",
        `${FIGURE_RENDERER_ENV}=graphviz 但未找到 graphviz dot 可执行文件：请安装 graphviz（brew install graphviz），` +
          `或用 SATI_GRAPHVIZ_DOT 指定 dot 路径；改回内置渲染器可 unset ${FIGURE_RENDERER_ENV}`,
        { tool },
      );
    }
  } else if (renderer === "graphviz-wasm") {
    // graphviz-wasm 不依赖系统 dot 二进制；WASM 加载失败在首次渲染时 fail-loud，
    // 绝不静默回退内置渲染器（那会让"要 graphviz 布局"的意图被悄悄违背）。
    wasmRunner = createWasmDotRunner();
  }
  // 只有内置渲染器能画的图型（曲线/时序/电路/多面板）：先于落盘整体拒绝，
  // 避免"前几幅写盘、后几幅报错"的半成品目录。
  if (renderer !== "builtin") {
    assertBuiltinRenderableFigures(figures, renderer, FIGURE_RENDERER_ENV, tool);
  }
  const renderOne = async (figure: FigureSpec): Promise<string> => {
    if (renderer === "graphviz" && dotPath !== null) {
      return (await renderFigureSvgWithGraphviz(figure, { dotPath, jurisdiction, figureCount })).svg;
    }
    if (renderer === "graphviz-wasm" && wasmRunner !== undefined) {
      return (await renderFigureSvgWithGraphviz(figure, { runner: wasmRunner, jurisdiction, figureCount })).svg;
    }
    return renderFigureSvg(figure, { jurisdiction, figureCount }).svg;
  };
  return { renderer, renderOne };
}

/**
 * 逐幅产物装配：渲染 + SVG 落盘 + 可选落版页（文件名形态与 layout 字段与 CAD 通路
 * 共用 writeSubmissionPageArtifact，见 figuregen/deliverables.ts）。
 */
async function renderFigureArtifacts(args: {
  figures: FigureSpec[];
  renderOne: (figure: FigureSpec) => Promise<string>;
  outputDir: string;
  outputName: string;
  profile: OfficeProfile;
  sheet: { index: number; total: number } | undefined;
  sheetText: string | undefined;
  fitToPage: boolean | undefined;
  figureCount: number;
  sourceCharMm: number;
  /** 落版参数（部署级：旋转角与图号/页码字号）。 */
  submissionStyle: SubmissionStyleOptions;
}): Promise<{
  files: RenderedFigureFile[];
  pagePaths: { path: string; figure_no: number }[];
  renderedSvgs: Map<number, string>;
}> {
  const { figures, renderOne, outputDir, outputName, profile, sheet, sheetText, sourceCharMm } = args;
  const { submissionStyle } = args;
  const files: RenderedFigureFile[] = [];
  const renderedSvgs = new Map<number, string>();
  const pagePaths: { path: string; figure_no: number }[] = [];
  for (const figure of figures) {
    // 渲染前归一（标号可见化）：把「已声明 ref 但图面没画标号」的节点补上 `(ref)`，
    // **在布局之前**做——布局的盒宽预算与渲染出的文字必须同源，否则补画出来的几个
    // 字符会撑破盒宽，渲染复核报「文字被框线贯穿」（RC1）把交付门打红。
    // 归一只作用于渲染面：sidecar 记录的仍是调用方声明的原始 spec。
    const svg = await renderOne(applyVisibleNumerals(figure));
    const path = resolve(outputDir, `${outputName}-fig${figure.figure_no}.svg`);
    await writeFile(path, svg, "utf8");
    const caption = figureCaption(profile, figure.figure_no, args.figureCount);
    const entry: RenderedFigureFile = { path, figure_no: figure.figure_no };
    if (caption !== undefined) entry.caption = caption;
    if (sheet !== undefined && sheetText !== undefined) entry.sheet = { ...sheet, text: sheetText };
    renderedSvgs.set(figure.figure_no, svg);

    // 落版页（附加产物）：图号在图形下、页码在版心上沿，法域档案同时决定纸面常数与编号体例。
    // 页面层不再画图号：图形自身已把图号画在标注带上（4.3「标注在相应附图的正下方」），
    // 而需要编号时图形必有图号、不需要编号时（pct/us 单幅）页面也不得出现 "Fig."。
    if (args.fitToPage === true) {
      // 落版页的装配（文件名形态 + sidecar 的 layout 字段）与 CAD 通路共用一份实现，
      // 避免"新增附加产物要改两处、漏改则同一工具族给出不同 sidecar"。
      const page = await writeSubmissionPageArtifact({
        outputDir,
        outputName,
        figureNo: figure.figure_no,
        drawingSvg: svg,
        office: profile.office,
        ...(sheet === undefined || sheetText === undefined
          ? {}
          : { sheet: { index: sheet.index, total: sheet.total } }),
        sourceCharHeightMm: sourceCharMm,
        rotateDeg: submissionStyle.rotateDeg,
        captionFontMm: submissionStyle.captionFontMm,
        captionGapMm: submissionStyle.captionGapMm,
        sheetFontMm: submissionStyle.sheetFontMm,
      });
      pagePaths.push({ path: page.path, figure_no: figure.figure_no });
      entry.layout = page.layout;
    }
    files.push(entry);
  }
  return { files, pagePaths, renderedSvgs };
}

/** 文本转路径收尾（可选，最后一步）：全部 SVG 落盘之后、sidecar 落盘之前。 */
async function exportFiguresTextToPath(paths: readonly string[], inkscape: InkscapeProbe, tool: string): Promise<void> {
  for (const svgPath of paths) {
    const outcome = await exportSvgTextToPath({ path: svgPath, cmd: inkscape.cmd });
    if (!outcome.ok) {
      throw new SatiToolRuntimeError(
        "tool_execution_failed",
        `文本转路径失败（${svgPath}）：${outcome.error}${
          outcome.installHint === undefined ? "" : `——${outcome.installHint}`
        }`,
        { tool, path: svgPath, reason: outcome.reason },
      );
    }
  }
}

export function createPatentFigureGenerateTool(): SatiToolDefinition<PatentFigureGenerateInput> {
  return {
    name: "patent_figure_generate",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["output_name", "jurisdiction", "office", "renderer", "figures", "sidecar_path", "check"],
      properties: {
        output_name: { type: "string" },
        jurisdiction: { type: "string", enum: JURISDICTIONS },
        office: { type: "string", description: "法域档案键（决定纸面常数与编号体例）" },
        renderer: { type: "string", enum: ["builtin", "graphviz", "graphviz-wasm"] },
        figures: { type: "array", items: FIGURE_ARTIFACT_SCHEMA, description: "图形 SVG（主产物）" },
        pages: { type: "array", items: FIGURE_ARTIFACT_SCHEMA, description: "提交落版页（fit_to_page 时非空）" },
        html_path: { type: "string", description: "A4 打印版式 HTML（format=html/both 时出现）" },
        sidecar_path: { type: "string", description: "sidecar（FigureSpec + 生成期核验）留痕路径" },
        indexed: { type: "boolean", description: "本次生成物是否已写入附图索引（false 时未入索引）" },
        compliance: {
          type: "array",
          description: "附图合规核算（图号义务 / 字高下限 / 摘要附图缩放；未命中时为空）",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["figure_no", "id", "severity", "message"],
            properties: {
              figure_no: { type: "integer" },
              id: { type: "string" },
              severity: { type: "string", enum: ["warn"] },
              message: { type: "string" },
            },
          },
        },
        check: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "findings"],
          properties: {
            ok: { type: "boolean", description: "生成期核验无 fail（文本侧规则未参与）" },
            findings: { type: "array", items: FIGURE_FINDING_SCHEMA },
          },
          description:
            "生成期核验（结构 V* + 渲染复核 RC* + 跨调用图号/标号占用；V2/V3 需说明书文本，以 patent_figure_check 为准）",
        },
      },
    },
    aliases: ["PatentFigureGenerate", "figure_generate"],
    title: "Generate Patent Figures",
    description:
      "Render patent-style figures from structured FigureSpec: flowcharts, block diagrams, state diagrams, " +
      "component hierarchies, and curve charts. Deterministic black-and-white SVG compliant with CNIPA " +
      "drawing rules, with reference numerals stored as data-ref and bidirectional figure/spec validation. " +
      "Numbering follows the target office (CN figure N; PCT/US Fig. N, omitted for a single view). Returns " +
      "SVG paths and a draft Brief Description of Drawings.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["figures", "output_name"],
      properties: {
        figures: {
          type: "array",
          minItems: 1,
          items: FIGURE_INPUT_SCHEMA_REF,
          description: "FigureSpec list.",
        },
        output_name: { type: "string", description: "Output base name." },
        case_id: { type: "string", description: "Case id." },
        output_dir: { type: "string", description: "Output dir." },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "invention / utility.",
        },
        invention_name: { type: "string", description: "Invention name." },
        brief: { type: "boolean", description: "Also write the brief." },
        format: {
          type: "string",
          enum: ["svg", "html", "both"],
          description: "svg|html|both.",
        },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description: "cn|us|pct.",
        },
        figure_count: {
          type: "integer",
          minimum: 1,
          description: "Total figures in case.",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "Sheet index (with sheet_total).",
        },
        sheet_total: {
          type: "integer",
          minimum: 1,
          description: "Total sheets.",
        },
        fit_to_page: {
          type: "boolean",
          description: "Also write the page SVG.",
        },
        auto_numbering: {
          type: "boolean",
          description: "Auto-assign reference numerals (env default off).",
        },
        numeral_start: {
          type: "integer",
          minimum: 1,
          description: "Auto-numbering series start (default 100+100*(fig-1)).",
        },
        numeral_step: {
          type: "integer",
          minimum: 1,
          description: "Auto-numbering step (default 2).",
        },
        reserved: {
          type: "array",
          items: { type: "string" },
          description: 'Reserved numerals to skip (e.g. "100").',
        },
        figure_family: {
          type: "string",
          description: "Shared numeral series for this call's figures (e.g. FIG.1A/1B).",
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
      const tool = "patent_figure_generate";
      const figures = input.figures;
      if (!Array.isArray(figures) || figures.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figures 不能为空（至少 1 幅附图）", {
          tool,
        });
      }
      assertFigurePayloads(figures, tool);
      // 标号归一（回填 + 可选自动分配）：**只改 ref，不改 label 文本**（可见标号的补画
      // 在渲染期做，见 renderFigureArtifacts 的说明——布局与图面文字必须同源）。
      // 自动分配是**部署级开关**（SATI_FIGURE_AUTO_NUMBERING，缺省 off），
      // **per-call 的 auto_numbering 优先于 env**（入参是本次调用的显式选择）。
      const autoNumbering = input.auto_numbering ?? resolveAutoNumbering();
      // 族标识（figure_family）：给出时本次调用的各图**共享一个连续标号系列**
      // （FIG.1A/1B 这对部分视图必须共用号段，否则同一部件在两幅图里是两个号）。
      const figureFamily = input.figure_family?.trim();
      if (input.figure_family !== undefined && (figureFamily === undefined || figureFamily === "")) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figure_family 不能为空字符串", { tool });
      }
      const {
        figures: normalizedFigures,
        assignments: numeralAssignments,
        family: familyInfo,
      } = normalizeFigureNumerals(figures, {
        auto: autoNumbering,
        ...(input.numeral_start === undefined ? {} : { start: input.numeral_start }),
        ...(input.numeral_step === undefined ? {} : { step: input.numeral_step }),
        ...(input.reserved === undefined ? {} : { reserved: input.reserved }),
        ...(figureFamily === undefined ? {} : { family: figureFamily }),
      });
      // 字体独立导出（`SATI_FIGURE_TEXT_TO_PATH`，默认关）：**先探测、后落盘**——若开关
      // 开了却没有 Inkscape，必须在写出任何产物之前 fail-loud，否则会留下"图形已落盘但
      // 没转路径"的半成品目录（调用方拿到的产物与声明不符）。
      const inkscape = resolveInkscapeProbe(tool);
      // `format` 此前在 SVGs 与 sidecar 都已落盘**之后**才校验：非法值会先写出一个半成品
      // 输出目录、再抛错。入参校验集中到落盘之前。
      const format = input.format ?? "svg";
      if (!FORMATS.includes(format)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `非法 format "${format}"（可用: ${FORMATS.join(", ")}）`, {
          tool,
          format,
        });
      }
      assertFigureOutputName(input.output_name, tool);
      // 渲染复核档位：与 format/renderer 同属「入参期决定的开关」，非法值必须在写出任何
      // 产物之前报错（否则会留下一个半成品目录）。
      const renderGate = resolveRenderGate();
      // 版面利用率下限（部署级 opt-in）：非法值与 renderGate 同属「入参期决定的开关」，
      // 必须在写出任何产物之前报错（否则会留下半成品目录）。
      const minSheetFillRatio = resolveMinSheetFillRatio();
      // 落版参数：部署级 env 打底，**per-call 入参优先**。非法值与 renderGate 同理——
      // 必须在写出任何产物之前报错，否则会留下半成品目录。
      const submissionStyle = resolveSubmissionStyle(process.env, tool, {
        ...(input.submission?.rotate_deg === undefined ? {} : { rotateDeg: input.submission.rotate_deg }),
        ...(input.submission?.caption_font_mm === undefined ? {} : { captionFontMm: input.submission.caption_font_mm }),
        ...(input.submission?.caption_gap_mm === undefined ? {} : { captionGapMm: input.submission.caption_gap_mm }),
        ...(input.submission?.sheet_font_mm === undefined ? {} : { sheetFontMm: input.submission.sheet_font_mm }),
      });

      const documentKind = toDocumentKind(input.document_kind);
      const jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const figureCount = toFigureCount(input.figure_count, figures.length);
      const sheet = validateSheetArgs(input, tool);
      const outputDir = resolveFigureOutputDir(input, context.cwd);
      await mkdir(outputDir, { recursive: true });

      try {
        // 渲染 → 实测画幅 → 结构规则（V1/V4/V5/V7/V8/V9 + V12–V14 图面用语）。V7 必须
        // 吃**实际交付文件**的尺寸：graphviz 的 14pt 字与内置 14px 字排出的画幅不同，
        // 用布局重排会把放得下的图判成超框。V2/V3 需说明书文本，属 patent_figure_check。
        const { renderer, renderOne } = resolveRenderPipeline(normalizedFigures, jurisdiction, figureCount, tool);
        const captionRendered = shouldRenderCaption(profile, figureCount);
        // 与门禁共用同一映射：两处各写一份时 graphviz-wasm 会在一侧漏掉，同一张图
        // 在生成期按 14px、在门禁按 14pt 判字高。
        const sourceCharMm = sourceCharHeightMm(renderer, jurisdiction);
        const sheetText = sheet === undefined ? undefined : sheetNumberText(profile, sheet.index, sheet.total);
        const { files, pagePaths, renderedSvgs } = await renderFigureArtifacts({
          figures: normalizedFigures,
          renderOne,
          outputDir,
          outputName: input.output_name,
          profile,
          sheet,
          sheetText,
          fitToPage: input.fit_to_page,
          figureCount,
          sourceCharMm,
          submissionStyle,
        });
        const measuredPaperSizes = [...renderedSvgs].flatMap(([figureNo, svg]) => {
          const size = measureSvgPaperSize(svg);
          return size === undefined ? [] : [{ figure_no: figureNo, ...size }];
        });
        const check = checkFigures(normalizedFigures, "", {
          skipTextRules: true,
          documentKind: documentKind,
          jurisdiction: jurisdiction,
          figureCount,
          measuredPaperSizes,
          sourceCharHeightMm: sourceCharMm,
        });

        // 渲染复核（RC1–RC9）与跨调用一致性：两者都在**已生成、未落盘**的产物上做，发现
        // 与结构规则合并后统一随 sidecar/报告返回。跨调用以同目录既有 sidecar 为单一事实
        // 源——本次自己的 sidecar 尚未写出，但同名文件可能来自上一次调用，须排除（否则
        // 每次重生成都会把自己的旧图号判成"被占用"）。
        const renderFindings = reviewRenderedFigures({
          renderedSvgs,
          paperSizes: measuredPaperSizes,
          profile,
          gate: renderGate,
          minSheetFillRatio,
        });
        const priorSidecars = await readFigureSidecars(outputDir);
        const crossCall = crossCallReview({
          figures: normalizedFigures,
          priorSidecars: priorSidecars.filter(sidecar => sidecar.output_name !== input.output_name),
        });
        const checkAll: FigureCheck = {
          ...check,
          ok: check.ok && [...renderFindings, ...crossCall.findings].every(finding => finding.severity !== "fail"),
          findings: [...check.findings, ...renderFindings, ...crossCall.findings],
        };

        // 字体独立导出（可选收尾，最后一步）：把字形换成轮廓路径，使交付物不依赖读者机器
        // 上的字体。放在**全部 SVG 落盘之后、sidecar 落盘之前**——此后不再有模块解析这些
        // 文件的文本，而 sidecar 需要记录"产物已转路径"这一事实（回读语义见 sidecar.ts
        // 的 text_to_path：转路径后图面上的文字不再是 `<text>`，"可见图号"读不到不等于没有）。
        if (inkscape !== undefined) {
          await exportFiguresTextToPath(
            [...files.map(file => file.path), ...pagePaths.map(page => page.path)],
            inkscape,
            tool,
          );
        }

        // A4 打印版式 HTML：**先于** sidecar 落盘（清单要把它算进去）。
        let htmlPath: string | undefined;
        if (format === "html" || format === "both") {
          htmlPath = resolve(outputDir, `${input.output_name}-figures.html`);
          await writeFile(
            htmlPath,
            renderFiguresHtml(figures, { title: input.invention_name, jurisdiction, renderedSvgs }),
            "utf8",
          );
        }

        // 交付物清单（角色 + 文件名 + sha256 + 字节数 + mtime）：清单是**产物契约**的
        // 一部分——有了它才能证明「交付的那份就是案卷主路径上的那份」且没被改过
        // （对齐 DSH 的 verify_deliverable）。清单在**文本转路径之后**算（转路径会
        // 改写 SVG，哈希必须取最终形态），且**不含 sidecar 自身**（sidecar 承载清单，
        // 它的哈希在写入那一刻就变了——自指）。
        const deliverables = await buildDeliverableManifestForOutput({
          outputDir,
          files: [
            ...files.map(file => ({ role: "figure" as const, file: basename(file.path) })),
            ...pagePaths.map(page => ({ role: "submission-page" as const, file: basename(page.path) })),
            ...(htmlPath === undefined ? [] : [{ role: "html" as const, file: basename(htmlPath) }]),
          ],
        });

        // 附图产物 sidecar（v1）：把 FigureSpec 完整落盘，供下游在**有说明书文本时**
        // 零信息损耗地重跑全部规则（figure-gate 的输入契约，见 figuregen/sidecar.ts）。
        const sidecarPath = await writeFigureSidecar({
          outputDir,
          outputName: input.output_name,
          sidecar: buildFigureSidecar({
            outputName: input.output_name,
            renderer,
            jurisdiction,
            documentKind,
            files,
            figures: normalizedFigures,
            check: checkAll,
            skipTextRules: true,
            ...(inkscape === undefined ? {} : { textToPath: true }),
            ...(deliverables.length === 0 ? {} : { deliverables }),
          }),
        });

        // `fail` 档：产物与 sidecar 全部落盘**之后**才抛错——已交付的图可审计（调用方据
        // 报告与 sidecar 修复后重生成），而"先抛错后落盘"会留下半成品目录。缺省的 `warn`
        // 档不阻断：生成期发现的历史噪音（如 V8 摘要附图未指定）不应挡住已合规的图。
        if (renderGate === "fail") {
          const failures = checkAll.findings.filter(finding => finding.severity === "fail");
          if (failures.length > 0) {
            throw new SatiToolRuntimeError(
              "tool_execution_failed",
              `附图核验有 ${String(failures.length)} 条 fail 级发现（${failures.map(finding => finding.rule).join(", ")}）：` +
                `产物与 sidecar 已落盘（${sidecarPath}）可审计，修复后重生成`,
              {
                tool,
                sidecar_path: sidecarPath,
                rules: failures.map(finding => finding.rule),
                findings: failures.map(finding => `${finding.rule}: ${finding.message}`),
              },
            );
          }
        }

        // 附图索引（生成即入索引）：此前只有 analyze_patent_figure 写索引，**生成物检索不到**
        // ——「生成 → 检索回读」这一环是断开的，必须额外调一次多模态分析才能被
        // search_patent_figure 找到（DSH 的生成侧即写索引，`persist_index` 默认 true）。
        // 写入失败**降级但不静默**：报告与 data.indexed 如实写明「未入索引」及原因，
        // 不阻断产物交付（产物已落盘，可审计）。
        //
        // 门禁 fail 档抛错时**不写索引**：未过门禁的图不是可交付物，进检索索引会让
        // 「搜到的就是已交付的」这个隐含前提失效。
        const specByNo = new Map(figures.map(figure => [figure.figure_no, figure]));
        // 合规核算：物理量取落版度量（无落版页时取图形自身实测尺寸）。
        const compliance = collectComplianceFindings({
          figures,
          layouts: new Map(
            files
              .filter(file => file.layout !== undefined)
              .map(file => [file.figure_no, file.layout as NonNullable<typeof file.layout>]),
          ),
          measuredPaperSizes,
          profile,
          figureCount,
          captionRendered,
          sourceCharMm,
        });
        // 附图索引（生成即入索引）：此前只有 analyze_patent_figure 写索引，**生成物检索不到**
        // ——「生成 → 检索回读」这一环是断开的，必须额外调一次多模态分析才能被
        // search_patent_figure 找到（DSH 的生成侧即写索引，`persist_index` 默认 true）。
        // 写入失败**降级但不静默**：报告与 data.indexed 如实写明「未入索引」及原因。
        const { indexed, note: indexNote } = await writeFigureIndex({ figures, files, context });

        const rendererLabel: string | undefined =
          renderer === "graphviz" ? "graphviz dot" : renderer === "graphviz-wasm" ? "graphviz (WASM)" : undefined;
        const lines = buildGenerateReportLines({
          files,
          pagePaths,
          profile,
          jurisdiction,
          figureCount,
          captionRendered,
          sheetText,
          sheetTotal: sheet?.total,
          sidecarPath,
          htmlPath,
          check: checkAll,
          crossCallLines: crossCall.lines,
          renderGate,
          renderDefectCount: renderFindings.filter(finding => finding.severity !== "info" && finding.advisory !== true)
            .length,
          renderUnmeasuredCount: renderFindings.filter(finding => finding.severity === "info").length,
          renderAdvisoryCount: renderFindings.filter(finding => finding.advisory === true).length,
          brief: input.brief,
          figures: normalizedFigures,
          inventionName: input.invention_name,
          documentKind,
          rendererLabel,
          indexNote,
          indexed,
          compliance,
          numeralAssignments,
          ...(familyInfo === undefined ? {} : { numeralFamily: familyInfo }),
          ...(input.numeral_step === undefined ? {} : { numeralStep: input.numeral_step }),
        });

        const data = {
          output_name: input.output_name,
          jurisdiction,
          office: profile.office,
          renderer,
          figures: files.map(file => {
            const spec = specByNo.get(file.figure_no);
            const numeralMap = spec === undefined ? [] : buildNumeralMap(spec);
            return {
              figure_no: file.figure_no,
              path: file.path,
              ...(file.caption === undefined ? {} : { caption: file.caption }),
              ...(file.sheet === undefined ? {} : { sheet: file.sheet.text }),
              ...(numeralMap.length === 0 ? {} : { numeral_map: numeralMap }),
              ...(file.layout === undefined
                ? {}
                : {
                    layout: {
                      page_scale: file.layout.page_scale,
                      placed_width_mm: file.layout.placed_width_mm,
                      placed_height_mm: file.layout.placed_height_mm,
                      char_height_mm: file.layout.char_height_mm,
                      page_path: file.layout.file,
                    },
                  }),
            };
          }),
          pages: pagePaths.map(page => ({ figure_no: page.figure_no, path: page.path })),
          ...(htmlPath === undefined ? {} : { html_path: htmlPath }),
          sidecar_path: sidecarPath,
          indexed,
          ...(compliance.length === 0 ? {} : { compliance }),
          check: { ok: checkAll.ok, findings: checkAll.findings },
        };

        return {
          data,
          content: [
            { type: "text", text: lines.join("\n") },
            ...files.map(file => ({
              type: "file" as const,
              path: file.path,
              mimeType: "image/svg+xml",
              description: `Patent figure 图${file.figure_no}`,
            })),
            ...(htmlPath !== undefined
              ? [
                  {
                    type: "file" as const,
                    path: htmlPath,
                    mimeType: "text/html",
                    description: "Patent figures A4 print HTML",
                  },
                ]
              : []),
            ...pagePaths.map(page => ({
              type: "file" as const,
              path: page.path,
              mimeType: "image/svg+xml",
              description: `Patent figure submission page 图${page.figure_no}`,
            })),
            {
              type: "file" as const,
              path: sidecarPath,
              mimeType: "application/json",
              description: "Patent figures sidecar (FigureSpec + generation-time check)",
            },
          ],
        };
      } catch (err) {
        // `SatiToolRuntimeError` 原样透传：`code` 在本仓是**语义通道**——上层按它选恢复策略、
        // 按它识别"连续传非法入参"并熔断，`details` 也随之外传。折叠成 `tool_execution_failed`
        // 会把可修复的入参错误误报成执行环境故障（模型只会反复重试，不会去改 format）。
        if (err instanceof SatiToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_generate 执行失败: ${message}`, {
          tool,
        });
      }
    },
  };
}
