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
 * 渲染器选择走 SATI_FIGURE_RENDERER 环境变量（builtin 默认 / graphviz 本机可选
 * 增强，复杂大图用）：环境变量而非 inputSchema 选项，避免动 llm-replay 请求键。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  buildFigureBriefDraft,
  checkFigures,
  renderFigureSvg,
  renderFiguresHtml,
  type DocumentKind,
  type FigureSpec,
  type Jurisdiction,
} from "../../patent/figuregen/index.js";
import {
  FIGURE_RENDERER_ENV,
  renderFigureSvgWithGraphviz,
  resolveDotBinary,
} from "../../patent/figuregen/render-graphviz.js";
import { caseOutputsDir } from "../../patent/paths.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";
import { FIGURE_INPUT_SCHEMA_REF } from "./patentFigureSchema.js";

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
};

const FORMATS: readonly string[] = ["svg", "html", "both"];

/**
 * 渲染器选择：SATI_FIGURE_RENDERER=graphviz 时走本机 graphviz dot（复杂大图
 * 可选增强）；缺省 builtin。不做成 inputSchema 选项是因为默认注册工具的 schema
 * 参与 llm-replay 请求键，任何变更都须重录 fixture（见 figuregen 决策记录）。
 */
type FigureRenderer = "builtin" | "graphviz";

function resolveFigureRenderer(env: NodeJS.ProcessEnv = process.env): FigureRenderer {
  const value = (env[FIGURE_RENDERER_ENV] ?? "").trim();
  if (value === "" || value === "builtin") {
    return "builtin";
  }
  if (value === "graphviz") {
    return "graphviz";
  }
  throw new SatiToolRuntimeError(
    "invalid_tool_input",
    `非法 ${FIGURE_RENDERER_ENV} "${value}"（可用: builtin, graphviz）`,
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
      "Render patent-style figures (flowcharts for method claims, block diagrams for system claims) " +
      "from structured FigureSpec input. Deterministic black-and-white SVG compliant with CNIPA drawing " +
      "rules (Guidelines 2023 Part I Ch1 4.3/4.6): black lines on white, no gradients. Reference numerals " +
      "are structured fields embedded as data-ref attributes and validated against Rule 21 of the " +
      "Implementing Regulations (bidirectional figure/spec numeral consistency). Also returns a draft " +
      "of the Brief Description of Drawings section. Registered by default; pass `patentFigure: false` to skip.",
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
          enum: ["cn", "us"],
          description:
            "Jurisdiction (default cn): us renders FIG. N captions, skips CN-only rules (abstract figure, utility-model), emits English brief description",
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
      for (const figure of figures) {
        if (!Array.isArray(figure.nodes) || figure.nodes.length === 0) {
          throw new SatiToolRuntimeError("invalid_tool_input", `图${figure.figure_no} 的 nodes 不能为空`, {
            tool: "patent_figure_generate",
            figure_no: figure.figure_no,
          });
        }
      }
      if (!/^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,100}$/u.test(input.output_name)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `非法 output_name: ${JSON.stringify(input.output_name)}`, {
          tool: "patent_figure_generate",
        });
      }

      const documentKind: DocumentKind | undefined =
        input.document_kind === "utility" ? "utility" : input.document_kind === "invention" ? "invention" : undefined;
      const jurisdiction: Jurisdiction = input.jurisdiction === "us" ? "us" : "cn";

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
        // 生成期跑结构规则（V1/V4/V5/V7/V8/V9）；V2/V3 需说明书文本，属 patent_figure_check 职责。
        const check = checkFigures(figures, "", {
          skipTextRules: true,
          documentKind: documentKind,
          jurisdiction: jurisdiction,
        });
        const renderer = resolveFigureRenderer();
        let dotPath: string | null = null;
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
        }
        const files: { path: string; figure_no: number }[] = [];
        const renderedSvgs = new Map<number, string>();
        for (const figure of figures) {
          const { svg } =
            renderer === "graphviz" && dotPath !== null
              ? await renderFigureSvgWithGraphviz(figure, { dotPath, jurisdiction })
              : renderFigureSvg(figure, { jurisdiction });
          const path = resolve(outputDir, `${input.output_name}-fig${figure.figure_no}.svg`);
          await writeFile(path, svg, "utf8");
          files.push({ path, figure_no: figure.figure_no });
          renderedSvgs.set(figure.figure_no, svg);
        }

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
          await writeFile(htmlPath, renderFiguresHtml(figures, { title: input.invention_name, renderedSvgs }), "utf8");
        }

        const lines: string[] = [
          `已生成 ${files.length} 幅附图（黑白线条，审查指南一部一章 4.3/4.6 合规` +
            (renderer === "graphviz" ? "；渲染器: graphviz dot）：" : "）："),
          ...files.map(file => `- 图${file.figure_no}: ${file.path}`),
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
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `patent_figure_generate 执行失败: ${message}`, {
          tool: "patent_figure_generate",
        });
      }
    },
  };
}
