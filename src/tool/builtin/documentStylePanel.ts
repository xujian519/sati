/**
 * document_style_panel — 打开文书排版调参面板。
 *
 * 用户说「调排版 / 调整排版 / 改字号行距」等意图时调用：校验已生成的文书 HTML 路径，
 * 返回面板数据（kind='document_style_panel' + htmlPath + 初始 style），前端据此打开
 * 右侧调参抽屉（左表单 + 右 iframe 实时预览）。
 *
 * 注意：data 不含 HTML 全文（网关 data 字符串会截断至 4000 字符）；前端按 htmlPath 读文件。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DOCUMENT_STYLE_JSON_SCHEMA, type DocumentStyle } from "../../patent/document/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";

export type DocumentStylePanelInput = {
  html_path: string;
  style?: DocumentStyle;
};

export function createDocumentStylePanelTool(): SatiToolDefinition<DocumentStylePanelInput> {
  return {
    name: "document_style_panel",
    outputSchema: { type: "object", properties: {} },
    title: "Document Style Panel",
    description:
      "Open the document typography adjustment panel for a rendered patent HTML. " +
      "Call this when the user asks to adjust typography (字号/行距/页边距/字体/颜色/落款) of a generated document. " +
      "Pass `html_path` (the HTML file path returned by render_patent_document) and optional `style` preload. " +
      "Returns panel data (kind='document_style_panel', htmlPath, style); the UI then opens the right-side drawer for live preview.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["html_path"],
      properties: {
        html_path: {
          type: "string",
          description: "Absolute path to the rendered document HTML (from render_patent_document output)",
        },
        style: {
          ...DOCUMENT_STYLE_JSON_SCHEMA,
          description: "Initial typography parameters to preload into the panel (optional)",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const htmlPath = resolve(context.cwd, input.html_path);
      if (!existsSync(htmlPath)) {
        throw new SatiToolRuntimeError("invalid_tool_input", `HTML 文件不存在: ${input.html_path}`, {
          tool: "document_style_panel",
        });
      }
      return {
        content: [{ type: "text", text: `已打开文书排版调参面板：${input.html_path}` }],
        data: {
          kind: "document_style_panel",
          htmlPath,
          style: input.style ?? {},
        },
      };
    },
  };
}
