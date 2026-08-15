/**
 * render_patent_document — 从专利文书模板生成专业 HTML/PDF 交付物。
 *
 * 复用 src/patent/document 渲染核心：读取 assets/templates/patent/<template>/assets/template.html，
 * 注入品牌 CSS 变量（支持 theme.json 覆盖），按元素 id 替换内容，落盘 HTML，可选调用系统
 * Chrome 打印为 PDF。
 */

import {
  SatiDocumentInputError,
  renderPatentDocument as renderDocument,
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
const FORMATS: readonly ("html" | "pdf" | "both")[] = ["html", "pdf", "both"];

export type RenderPatentDocumentInput = {
  /** 模板 id：patentability-opinion / search-report / oa-response / claims-spec / invalidation-opinion */
  template: string;
  /** 输出文件名主干（不含扩展名）。 */
  output_name: string;
  /** 案卷 id（提供时结果落盘 data/cases/<caseId>/outputs/）。 */
  case_id?: string;
  /** 显式输出目录（覆盖默认目录）。 */
  output_dir?: string;
  /** html / pdf / both（默认 both）。 */
  format?: string;
  /** 按元素 id 注入的 HTML 内容（innerHTML）。 */
  sections: Record<string, string>;
  /** 内联品牌覆盖（优先级最高）。 */
  brand?: Record<string, string>;
  /** 显式品牌配置文件路径（缺省 products/_example/brand/theme.json）。 */
  brand_path?: string;
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
      "Render a professional patent-attorney document (HTML/PDF) from the bundled templates. " +
      "Injects brand variables (firm name, confidentiality, colors) from theme.json or explicit `brand`, " +
      "then replaces template sections by element id using `sections`. Templates: patentability-opinion, " +
      "search-report, oa-response, claims-spec, invalidation-opinion. Outputs a `.html` file; when " +
      "format is 'pdf' or 'both' and Chrome/Chromium is available, also outputs a `.pdf` via headless " +
      "print-to-PDF.",
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
          enum: ["html", "pdf", "both"],
          description: "Output format (default 'both')",
        },
        sections: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Map of element id -> innerHTML content to inject into the template",
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
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
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
          },
          context.cwd,
        );

        const lines: string[] = [`HTML: ${result.htmlPath}`];
        if (result.pdfPath !== undefined) {
          lines.push(`PDF: ${result.pdfPath}`);
        } else if (result.pdfError !== undefined) {
          lines.push(`PDF 未生成: ${result.pdfError}`);
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
