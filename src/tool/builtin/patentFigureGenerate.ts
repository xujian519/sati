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
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  buildFigureBriefDraft,
  buildFigureSidecar,
  checkFigures,
  figureCaption,
  MM_PER_INCH,
  profileForJurisdiction,
  pxToMm,
  renderFigureSvg,
  renderFiguresHtml,
  sheetNumberText,
  shouldRenderCaption,
  writeFigureSidecar,
  writeSubmissionPageArtifact,
  type DocumentKind,
  type FigureSidecarLayout,
  type FigureSidecarSheet,
  type FigureSpec,
  type Jurisdiction,
} from "../../patent/figuregen/index.js";
import {
  FIGURE_RENDERER_ENV,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
  type DotRunner,
} from "../../patent/figuregen/render-graphviz.js";
import { createWasmDotRunner } from "../../patent/figuregen/render-viz-wasm.js";
import { caseOutputsDir } from "../../patent/paths.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import {
  assertFigurePayloads,
  FIGURE_INPUT_SCHEMA_REF,
  JURISDICTIONS,
  toFigureCount,
  toJurisdiction,
  toSheet,
} from "./patentFigureSchema.js";

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

export function createPatentFigureGenerateTool(): SatiToolDefinition<PatentFigureGenerateInput> {
  return {
    name: "patent_figure_generate",
    outputSchema: { type: "object", properties: {} },
    aliases: ["PatentFigureGenerate", "figure_generate"],
    title: "Generate Patent Figures",
    description:
      "Render patent-style figures (flowcharts for method claims, block diagrams for system claims, " +
      "state transition diagrams, component hierarchy diagrams, and curve charts for measured data) " +
      "from structured FigureSpec input. Deterministic black-and-white SVG compliant with CNIPA drawing " +
      "rules (Guidelines 2023 Part I Ch1 4.3/4.6): black lines on white, no gradients. Reference numerals " +
      "are structured fields embedded as data-ref attributes and validated against Rule 21 of the " +
      "Implementing Regulations (bidirectional figure/spec numeral consistency). Figure numbering follows " +
      "the target office: CN numbers every figure (图N), while PCT/US omit the number when the case has " +
      "only one view (PCT Guide IP 5.141, 37 CFR 1.84(u)(1)) and use Fig. N / FIG. N otherwise. Paper " +
      "constants, minimum character height and page numbering come from the per-office profile " +
      "(CNIPA/PCT/USPTO, each value cited to its provision). Also returns a draft of the Brief " +
      "Description of Drawings section. Registered by default; pass `patentFigure: false` to skip.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["figures", "output_name"],
      properties: {
        figures: { type: "array", minItems: 1, items: FIGURE_INPUT_SCHEMA_REF, description: "附图数组（1..N 幅）" },
        output_name: { type: "string", description: "输出文件名主干（不含扩展名），生成 <name>-fig<N>.svg" },
        case_id: { type: "string", description: "案卷 id；提供时落盘 data/cases/<caseId>/outputs/" },
        output_dir: { type: "string", description: "显式输出目录（覆盖默认 .sati/figures/ 与 case_id）" },
        document_kind: {
          type: "string",
          enum: ["invention", "utility"],
          description: "发明/实用新型（影响附图说明措辞）",
        },
        invention_name: { type: "string", description: "发明名称（附图说明草稿引用）" },
        brief: { type: "boolean", description: "是否生成附图说明草稿（默认 true）" },
        format: {
          type: "string",
          enum: ["svg", "html", "both"],
          description: "Output format: svg (default) / A4 print single-file HTML / both",
        },
        jurisdiction: {
          type: "string",
          enum: JURISDICTIONS,
          description:
            "Target office (default cn): cn=CNIPA (图N captions, CN-only rules), us=USPTO (FIG. N, 37 CFR " +
            "1.84 profile), pct=PCT international application (Fig. N, PCT Rule 11 profile)",
        },
        figure_count: {
          type: "integer",
          minimum: 1,
          description:
            "本案附图总幅数（缺省取本次 figures 的幅数）：分次生成时须声明，它决定是否需要图号标注" +
            "（单幅在 pct/us 不得出现 Fig./FIG.）与纸面尺寸判据",
        },
        sheet_index: {
          type: "integer",
          minimum: 1,
          description: "附图页序号（与 sheet_total 成对声明；缺省不落页码）",
        },
        sheet_total: {
          type: "integer",
          minimum: 1,
          description: "附图页总页数（成对声明；页码体例按法域档案，CN 顺序数字、PCT/US 形如 1/3）",
        },
        fit_to_page: {
          type: "boolean",
          description:
            "是否另产提交落版页 <name>-fig<N>-page.svg（默认 false：图形 SVG 仍是主产物，落版页为附加页式件）",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const figures = input.figures;
      if (!Array.isArray(figures) || figures.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "figures 不能为空（至少 1 幅附图）", {
          tool: "patent_figure_generate",
        });
      }
      assertFigurePayloads(figures, "patent_figure_generate");
      if (!/^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,100}$/u.test(input.output_name)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `非法 output_name: ${JSON.stringify(input.output_name)}`, {
          tool: "patent_figure_generate",
        });
      }

      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      const jurisdiction: Jurisdiction = toJurisdiction(input.jurisdiction);
      const profile = profileForJurisdiction(jurisdiction);
      const figureCount = toFigureCount(input.figure_count, figures.length);
      const sheet = toSheet({ sheet_index: input.sheet_index, sheet_total: input.sheet_total });
      if (sheet === undefined && (input.sheet_index !== undefined || input.sheet_total !== undefined)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          "sheet_index 与 sheet_total 须成对给出且均 ≥1（附图页码体例由法域档案决定，缺一项无法判定）",
          { tool: "patent_figure_generate" },
        );
      }
      if (sheet !== undefined && sheet.index > sheet.total) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `sheet_index ${sheet.index} 超出 sheet_total ${sheet.total}`,
          { tool: "patent_figure_generate" },
        );
      }

      const outputDir =
        input.output_dir !== undefined
          ? isAbsolute(input.output_dir)
            ? input.output_dir
            : resolve(context.cwd, input.output_dir)
          : input.case_id !== undefined
            ? resolve(context.cwd, caseOutputsDir(input.case_id))
            : resolve(context.cwd, ".sati", "figures");
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
              { tool: "patent_figure_generate" },
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
              { tool: "patent_figure_generate", figure_no: chartFigure.figure_no },
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
        const files: {
          path: string;
          figure_no: number;
          caption?: string;
          sheet?: FigureSidecarSheet;
          layout?: FigureSidecarLayout;
        }[] = [];
        const renderedSvgs = new Map<number, string>();
        const captionRendered = shouldRenderCaption(profile, figureCount);
        const sourceCharMm = renderer === "graphviz" ? (14 / 72) * MM_PER_INCH : pxToMm(14);
        const sheetText = sheet === undefined ? undefined : sheetNumberText(profile, sheet.index, sheet.total);
        const pagePaths: { path: string; figure_no: number }[] = [];
        for (const figure of figures) {
          const svg = await renderOne(figure);
          const path = resolve(outputDir, `${input.output_name}-fig${figure.figure_no}.svg`);
          await writeFile(path, svg, "utf8");
          const caption = figureCaption(profile, figure.figure_no, figureCount);
          const entry: (typeof files)[number] = { path, figure_no: figure.figure_no };
          if (caption !== undefined) entry.caption = caption;
          if (sheet !== undefined && sheetText !== undefined) entry.sheet = { ...sheet, text: sheetText };
          renderedSvgs.set(figure.figure_no, svg);

          // 落版页（附加产物）：图号在图形下、页码在版心上沿，法域档案同时决定纸面常数与编号体例。
          // 页面层不再画图号：图形自身已把图号画在标注带上（4.3「标注在相应附图的正下方」），
          // 而需要编号时图形必有图号、不需要编号时（pct/us 单幅）页面也不得出现 "Fig."。
          if (input.fit_to_page === true) {
            // 落版页的装配（文件名形态 + sidecar 的 layout 字段）与 CAD 通路共用一份实现，
            // 避免"新增附加产物要改两处、漏改则同一工具族给出不同 sidecar"。
            const page = await writeSubmissionPageArtifact({
              outputDir,
              outputName: input.output_name,
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
          }),
        });

        const format = input.format ?? "svg";
        if (!FORMATS.includes(format)) {
          throw new SatiToolRuntimeError(
            "invalid_tool_input",
            `非法 format "${format}"（可用: ${FORMATS.join(", ")}）`,
            {
              tool: "patent_figure_generate",
              format,
            },
          );
        }
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
        const lines: string[] = [
          `已生成 ${files.length} 幅附图（黑白线条，审查指南一部一章 4.3/4.6 合规` +
            (rendererLabel === undefined ? "）：" : `；渲染器: ${rendererLabel}）：`),
          ...files.map(file => `- 图${file.figure_no}: ${file.path}`),
          `- 图号：${captionRendered ? `${figureCaption(profile, 1, figureCount)} 式样，标注在图形正下方` : "本案仅一幅附图，按 " + profile.office + " 档案不标注图号"}` +
            `（法域 ${jurisdiction} ⇒ 档案 ${profile.office}）`,
          ...(sheetText === undefined
            ? []
            : [`- 附图页页码：本图页写作 ${sheetText}（${files.length} 幅，共 ${sheet!.total} 页）`]),
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

        if (input.brief !== false) {
          const briefDraft = buildFigureBriefDraft(figures, {
            inventionName: input.invention_name,
            documentKind: documentKind,
            jurisdiction: jurisdiction,
          });
          lines.push("", "--- 附图说明草稿（可直接并入说明书） ---", briefDraft);
        }

        return {
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
          tool: "patent_figure_generate",
        });
      }
    },
  };
}
