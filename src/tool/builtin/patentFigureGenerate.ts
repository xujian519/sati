/**
 * patent_figure_generate — 从结构化 FigureSpec 确定性渲染专利附图（SVG / A4 HTML）。
 *
 * LLM 只产结构化节点/边/附图标记，不产图形；黑白线条合规（审查指南 2023 一部
 * 一章 4.3/4.6）是渲染器构造期不变式。生成后自动运行结构校验（V1/V4/V5/V7/V8/V9；
 * V2/V3 需说明书文本，属 patent_figure_check 职责），fail 级发现随结果返回
 * （不落盘阻断，由调用方决定修复重生成）。format=html/both 时另产 A4 打印版式
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
import { resolve } from "node:path";
import {
  FIGURE_RENDERER_ENV,
  buildFigureBriefDraft,
  buildFigureSidecar,
  checkFigures,
  createWasmDotRunner,
  exportSvgTextToPath,
  figureCaption,
  MM_PER_INCH,
  profileForJurisdiction,
  pxToMm,
  renderFigureSvg,
  renderFigureSvgWithGraphviz,
  renderFiguresHtml,
  resolveDotBinary,
  sheetNumberText,
  shouldRenderCaption,
  writeFigureSidecar,
  writeSubmissionPageArtifact,
  type DocumentKind,
  type DotRunner,
  type FigureSidecarLayout,
  type FigureSidecarSheet,
  type FigureSpec,
  type InkscapeProbe,
  type Jurisdiction,
  type OfficeProfile,
} from "../../patent/figuregen/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
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
  assertFigureOutputName,
  resolveFigureOutputDir,
  resolveInkscapeProbe,
  toDocumentKind,
  validateSheetArgs,
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

/** 渲染产物清单条目（sidecar 的 files 与 data.figures 共用）。 */
type RenderedFigureFile = {
  path: string;
  figure_no: number;
  caption?: string;
  sheet?: FigureSidecarSheet;
  layout?: FigureSidecarLayout;
};

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
        "tool_execution_failed",
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
  // 曲线图只能由内置渲染器绘制（graphviz 画不出坐标轴与数据曲线）：先于落盘整体拒绝，
  // 避免"前几幅写盘、后几幅报错"的半成品目录。
  if (renderer !== "builtin") {
    const chartFigure = figures.find(figure => figure.kind === "chart");
    if (chartFigure !== undefined) {
      throw new SatiToolRuntimeError(
        "tool_execution_failed",
        `图${chartFigure.figure_no} 是曲线图（kind="chart"），${FIGURE_RENDERER_ENV} 通路（${renderer}）无法绘制：` +
          `请去掉 ${FIGURE_RENDERER_ENV} 或设为 builtin 后重试（曲线图走内置矢量渲染器）`,
        { tool, figure_no: chartFigure.figure_no },
      );
    }
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
}): Promise<{
  files: RenderedFigureFile[];
  pagePaths: { path: string; figure_no: number }[];
  renderedSvgs: Map<number, string>;
}> {
  const { figures, renderOne, outputDir, outputName, profile, sheet, sheetText, sourceCharMm } = args;
  const files: RenderedFigureFile[] = [];
  const renderedSvgs = new Map<number, string>();
  const pagePaths: { path: string; figure_no: number }[] = [];
  for (const figure of figures) {
    const svg = await renderOne(figure);
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

/** 报告文本（行式摘要：逐幅路径、图号体例、页码、落版页、sidecar、核验发现与附图说明草稿）。 */
function buildGenerateReportLines(args: {
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
  brief: boolean | undefined;
  figures: FigureSpec[];
  inventionName: string | undefined;
  documentKind: DocumentKind | undefined;
  rendererLabel: string | undefined;
}): string[] {
  const { files, pagePaths, profile, jurisdiction, figureCount, captionRendered } = args;
  const { sheetText, sheetTotal, sidecarPath, htmlPath, check, brief, figures, rendererLabel } = args;
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
  ];
  if (htmlPath !== undefined) {
    lines.push(`A4 打印版式 HTML（PDF 可经 export_html 产出）: ${htmlPath}`);
  }

  if (check.findings.length > 0) {
    lines.push(
      "",
      "附图结构核验（生成期 spec_text 为空，V2/V3 结果以 patent_figure_check 提交说明书后为准）：",
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
        check: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "findings"],
          properties: {
            ok: { type: "boolean", description: "生成期核验无 fail（文本侧规则未参与）" },
            findings: { type: "array", items: FIGURE_FINDING_SCHEMA },
          },
          description: "生成期结构核验（V2/V3 需说明书文本，以 patent_figure_check 为准）",
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
          description: "FigureSpec figures (1..N).",
        },
        output_name: { type: "string", description: "Output base name." },
        case_id: { type: "string", description: "Case id (writes to data/cases/<caseId>/outputs/)." },
        output_dir: { type: "string", description: "Override output directory." },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "invention / utility.",
        },
        invention_name: { type: "string", description: "Invention name for the drawing brief." },
        brief: { type: "boolean", description: "Generate the drawing brief (default true)." },
        format: {
          type: "string",
          enum: ["svg", "html", "both"],
          description: "svg (default) / print HTML / both.",
        },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description: "cn (CNIPA) / us (USPTO) / pct.",
        },
        figure_count: {
          type: "integer",
          minimum: 1,
          description: "Total figure count in the case.",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "Sheet index (paired with sheet_total).",
        },
        sheet_total: {
          type: "integer",
          minimum: 1,
          description: "Total sheets.",
        },
        fit_to_page: {
          type: "boolean",
          description: "Also produce <name>-fig<N>-page.svg.",
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

      const documentKind = toDocumentKind(input.document_kind);
      const jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const figureCount = toFigureCount(input.figure_count, figures.length);
      const sheet = validateSheetArgs(input, tool);
      const outputDir = resolveFigureOutputDir(input, context.cwd);
      await mkdir(outputDir, { recursive: true });

      try {
        // 生成期跑结构规则（V1/V4/V5/V7/V8/V9 + V12–V14 图面用语）；V2/V3 需说明书文本，
        // 属 patent_figure_check 职责。figureCount 决定图号是否需要标注 ⇒ 也决定纸面尺寸判据
        // 与渲染画幅（两处必须同源，否则核验量的是另一张图）。
        const check = checkFigures(figures, "", {
          skipTextRules: true,
          documentKind: documentKind,
          jurisdiction: jurisdiction,
          figureCount,
        });
        const { renderer, renderOne } = resolveRenderPipeline(figures, jurisdiction, figureCount, tool);
        const captionRendered = shouldRenderCaption(profile, figureCount);
        const sourceCharMm = renderer === "graphviz" ? (14 / 72) * MM_PER_INCH : pxToMm(14);
        const sheetText = sheet === undefined ? undefined : sheetNumberText(profile, sheet.index, sheet.total);
        const { files, pagePaths, renderedSvgs } = await renderFigureArtifacts({
          figures,
          renderOne,
          outputDir,
          outputName: input.output_name,
          profile,
          sheet,
          sheetText,
          fitToPage: input.fit_to_page,
          figureCount,
          sourceCharMm,
        });

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
            figures,
            check,
            skipTextRules: true,
            ...(inkscape === undefined ? {} : { textToPath: true }),
          }),
        });

        let htmlPath: string | undefined;
        if (format === "html" || format === "both") {
          htmlPath = resolve(outputDir, `${input.output_name}-figures.html`);
          await writeFile(
            htmlPath,
            renderFiguresHtml(figures, { title: input.invention_name, jurisdiction, renderedSvgs }),
            "utf8",
          );
        }

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
          check,
          brief: input.brief,
          figures,
          inventionName: input.invention_name,
          documentKind,
          rendererLabel,
        });

        const data = {
          output_name: input.output_name,
          jurisdiction,
          office: profile.office,
          renderer,
          figures: files.map(file => ({
            figure_no: file.figure_no,
            path: file.path,
            ...(file.caption === undefined ? {} : { caption: file.caption }),
            ...(file.sheet === undefined ? {} : { sheet: file.sheet.text }),
          })),
          pages: pagePaths.map(page => ({ figure_no: page.figure_no, path: page.path })),
          ...(htmlPath === undefined ? {} : { html_path: htmlPath }),
          sidecar_path: sidecarPath,
          check: { ok: check.ok, findings: check.findings },
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
