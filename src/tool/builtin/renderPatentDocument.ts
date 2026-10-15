/**
 * render_patent_document — 从专利文书模板生成专业 HTML/PDF 交付物，以及（可选）申请文件 docx。
 *
 * 复用 src/patent/document 渲染核心：读取 assets/templates/patent/<template>/assets/template.html，
 * 注入品牌 CSS 变量（支持 theme.json 覆盖），按元素 id 替换内容，落盘 HTML，可选调用系统
 * Chrome 打印为 PDF。`format: "docx" | "all"` 时另经 src/patent/document/docx 以模板自带的
 * Word 母版（assets/template.docx）为版面，把五件套内容填进对应分节。
 */

import {
  SatiDocumentInputError,
  renderPatentDocument as renderDocument,
  DOCUMENT_STYLE_JSON_SCHEMA,
  APPLICATION_DOCX_PART_IDS,
  type DocumentStyle,
  type DocumentTemplateId,
  type RenderFormat,
} from "../../patent/document/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";

/** 支持的模板 id（与 assets/templates/patent/manifest.json 保持一致）。 */
const TEMPLATE_IDS: readonly DocumentTemplateId[] = [
  "patentability-opinion",
  "search-report",
  "oa-response",
  "claims-spec",
  "invalidation-opinion",
];

/** 支持的输出格式。 */
const FORMATS: readonly RenderFormat[] = ["html", "pdf", "both", "docx", "all"];

/** docx 输出的件键（与 `APPLICATION_PARTS` 同源，用于文档与错误提示）。 */
const DOCX_PART_IDS = APPLICATION_DOCX_PART_IDS;

export type RenderPatentDocumentInput = {
  /** 模板 id：patentability-opinion / search-report / oa-response / claims-spec / invalidation-opinion */
  template: string;
  /** 输出文件名主干（不含扩展名）。 */
  output_name: string;
  /** 案卷 id（提供时结果落盘 data/cases/<caseId>/outputs/）。 */
  case_id?: string;
  /** 显式输出目录（覆盖默认目录）。 */
  output_dir?: string;
  /** html / pdf / both / docx / all（默认 both）。 */
  format?: string;
  /** HTML/PDF 路径：按元素 id 注入的 HTML 内容；docx 路径：按申请文件件 id（见 APPLICATION_DOCX_PART_IDS）。 */
  sections: Record<string, string>;
  /** 内联品牌覆盖（优先级最高）。 */
  brand?: Record<string, string>;
  /** 显式品牌配置文件路径（缺省 products/_example/brand/theme.json）。 */
  brand_path?: string;
  /** 排版参数覆盖（结构化；优先级高于 brand / theme.json）。 */
  style?: DocumentStyle;
  /** 样式预设名（加载 style-presets/<name>.json；显式 style 覆盖预设）。 */
  style_preset?: string;
};

export function createRenderPatentDocumentTool(): SatiToolDefinition<RenderPatentDocumentInput> {
  return {
    name: "render_patent_document",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["RenderPatentDocument", "render_document"],
    title: "Render Patent Document",
    description:
      "Render a professional patent-attorney document from the bundled templates. " +
      "Injects brand variables (firm name, confidentiality, colors) from theme.json or explicit `brand`, " +
      "then replaces template sections by element id using `sections`. Templates: patentability-opinion, " +
      "search-report, oa-response, claims-spec, invalidation-opinion. Always outputs a `.html` file; " +
      "format 'pdf'/'both'/'all' also prints a `.pdf` via headless Chrome when available; format " +
      "'docx'/'all' also fills the patent **application package** `.docx` whose layout comes from the " +
      "template's own Word master (A4, per-part page headers/footers and page numbers, official 5-part " +
      "order). For the docx path, `sections` keys are the application parts: " +
      `${DOCX_PART_IDS.join(" / ")} (abstract / abstract figure / claims / specification / drawings); ` +
      "those values accept HTML (headings, paragraphs, lists, tables, inline images) or plain text. " +
      "docx requires a template that ships assets/template.docx — currently claims-spec.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["template", "output_name", "sections"],
      properties: {
        template: {
          type: "string",
          enum: ["patentability-opinion", "search-report", "oa-response", "claims-spec", "invalidation-opinion"],
          description: "Template id from assets/templates/patent/manifest.json",
        },
        output_name: { type: "string", description: "Output file base name (no extension)" },
        case_id: { type: "string", description: "Case id; writes to data/cases/<caseId>/outputs/" },
        output_dir: { type: "string", description: "Override output directory" },
        format: {
          type: "string",
          enum: ["html", "pdf", "both", "docx", "all"],
          description:
            "Extra outputs beyond HTML: 'pdf'/'both' = PDF, 'docx' = patent application .docx, 'all' = both (default 'both')",
        },
        sections: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Map of id -> HTML content. HTML/PDF path: template element id (e.g. meta-title). " +
            `docx path: application part id (${DOCX_PART_IDS.join(", ")})`,
        },
        brand: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Inline brand overrides (e.g. firm, confidential, accent)",
        },
        brand_path: {
          type: "string",
          description: "Path to theme.json brand config (defaults to products/_example/brand/theme.json)",
        },
        style: {
          ...DOCUMENT_STYLE_JSON_SCHEMA,
          description:
            "Typography/layout overrides (font size, line height, page margin, font family, color, brand). Higher priority than brand/theme.json.",
        },
        style_preset: {
          type: "string",
          description:
            "Style preset name from products/<product>/brand/style-presets/; explicit `style` overrides the preset",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    // 交付物渲染是面向客户的终局动作：默认 skipPermissions 下不该无人值守地落盘。
    alwaysAsk: true,
    async execute(input, context: SatiToolRuntimeContext) {
      // 输入契约校验（fail-closed；即使绕过 schema 校验也在此拦截）。
      if (!TEMPLATE_IDS.includes(input.template as DocumentTemplateId)) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `未知模板 "${input.template}"（可用: ${TEMPLATE_IDS.join(", ")}）`,
          { tool: "render_patent_document", template: input.template },
        );
      }
      const format = (input.format ?? "both") as RenderFormat;
      if (!FORMATS.includes(format)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `非法 format "${input.format}"`, {
          tool: "render_patent_document",
          format: input.format,
        });
      }

      try {
        const result = await renderDocument(
          {
            template: input.template as DocumentTemplateId,
            outputName: input.output_name,
            caseId: input.case_id,
            outputDir: input.output_dir,
            format,
            sections: input.sections,
            brand: input.brand,
            brandPath: input.brand_path,
            style: input.style,
            stylePreset: input.style_preset,
          },
          context.cwd,
        );

        const lines: string[] = [`HTML: ${result.htmlPath}`];
        if (result.pdfPath !== undefined) {
          lines.push(`PDF: ${result.pdfPath}`);
        } else if (result.pdfError !== undefined) {
          lines.push(`PDF 未生成: ${result.pdfError}`);
        }
        if (result.docxPath !== undefined) {
          lines.push(`DOCX: ${result.docxPath}`);
        } else if (result.docxError !== undefined) {
          lines.push(`DOCX 未生成: ${result.docxError}`);
        }
        if (result.warnings !== undefined && result.warnings.length > 0) {
          lines.push(`提示: ${result.warnings.join("；")}`);
        }

        return {
          content: [
            { type: "text", text: lines.join("\n") },
            // 产物路径同步暴露为 file 块，便于 FileArtifactCollector 识别。
            {
              type: "file",
              path: result.htmlPath,
              mimeType: "text/html",
              description: "Rendered patent document HTML",
            },
            ...(result.pdfPath !== undefined
              ? [
                  {
                    type: "file" as const,
                    path: result.pdfPath,
                    mimeType: "application/pdf",
                    description: "Rendered patent document PDF",
                  },
                ]
              : []),
            ...(result.docxPath !== undefined
              ? [
                  {
                    type: "file" as const,
                    path: result.docxPath,
                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    description: "Rendered patent application DOCX",
                  },
                ]
              : []),
          ],
        };
      } catch (err) {
        // 用户输入错误（非法文件名/案卷号/模板）归为 invalid_tool_input。
        if (err instanceof SatiDocumentInputError) {
          throw new SatiToolRuntimeError("invalid_tool_input", err.message, { tool: "render_patent_document" });
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new SatiToolRuntimeError("tool_execution_failed", `render_patent_document 执行失败: ${message}`, {
          tool: "render_patent_document",
        });
      }
    },
  };
}
