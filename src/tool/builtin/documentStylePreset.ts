/**
 * document_style_preset — 管理专利文书排版样式预设（save / list / get / delete）。
 *
 * 预设持久化于 products/<产品>/brand/style-presets/<name>.json，
 * 供 render_patent_document 的 style_preset 参数复用「事务所样式」。
 */

import { resolve } from "node:path";
import {
  deleteStylePreset,
  listStylePresets,
  loadStylePreset,
  resolvePresetDirFromBrandPath,
  saveStylePreset,
  DOCUMENT_STYLE_JSON_SCHEMA,
  type DocumentStyle,
} from "../../patent/document/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";

/** 默认品牌配置文件路径（与 renderPatentDocument 一致）。 */
const DEFAULT_BRAND_PATH = "products/_example/brand/theme.json";

const ACTIONS = ["save", "list", "get", "delete"] as const;
type Action = (typeof ACTIONS)[number];

export type DocumentStylePresetInput = {
  action: Action;
  name?: string;
  description?: string;
  style?: DocumentStyle;
};

function defaultPresetDir(cwd: string): string {
  return resolvePresetDirFromBrandPath(resolve(cwd, DEFAULT_BRAND_PATH));
}

function requireName(action: string, name: string | undefined): string {
  if (name === undefined || name.trim() === "") {
    throw new SatiToolRuntimeError("invalid_tool_input", `${action} 需要 name`, { tool: "document_style_preset" });
  }
  return name;
}

export function createDocumentStylePresetTool(): SatiToolDefinition<DocumentStylePresetInput> {
  return {
    name: "document_style_preset",
    outputSchema: { type: "object", properties: {} },
    title: "Document Style Preset",
    description:
      "Manage reusable patent-document typography presets (save / list / get / delete). " +
      "Presets persist to products/<product>/brand/style-presets/<name>.json and can be applied " +
      "by render_patent_document via `style_preset`. Use to save a firm's house style for reuse.",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: "save=保存预设 / list=列出预设 / get=读取单个预设 / delete=删除预设",
        },
        name: { type: "string", description: "预设名（save/get/delete 必需）" },
        description: { type: "string", description: "预设说明（save 可选）" },
        style: {
          ...DOCUMENT_STYLE_JSON_SCHEMA,
          description: "排版参数（save 必需；get 返回该结构）",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const presetDir = defaultPresetDir(context.cwd);
      switch (input.action) {
        case "save": {
          const name = requireName("save", input.name);
          if (input.style === undefined) {
            throw new SatiToolRuntimeError("invalid_tool_input", "save 需要 style", { tool: "document_style_preset" });
          }
          const path = saveStylePreset(presetDir, {
            name,
            description: input.description,
            style: input.style,
          });
          return {
            content: [{ type: "text", text: `已保存样式预设 "${name}" → ${path}` }],
          };
        }
        case "list": {
          const presets = listStylePresets(presetDir);
          if (presets.length === 0) {
            return { content: [{ type: "text", text: "尚无样式预设（save 后可复用）" }] };
          }
          const lines = presets.map(p => `- ${p.name}${p.description ? `：${p.description}` : ""}`);
          return {
            content: [{ type: "text", text: `样式预设（${presets.length}）:\n${lines.join("\n")}` }],
            data: presets.map(p => ({ name: p.name, description: p.description, updatedAt: p.updatedAt })),
          };
        }
        case "get": {
          const name = requireName("get", input.name);
          const preset = loadStylePreset(presetDir, name);
          return {
            content: [{ type: "text", text: JSON.stringify(preset, null, 2) }],
            data: preset,
          };
        }
        case "delete": {
          const name = requireName("delete", input.name);
          const ok = deleteStylePreset(presetDir, name);
          return {
            content: [{ type: "text", text: ok ? `已删除样式预设 "${name}"` : `预设不存在: ${name}` }],
          };
        }
      }
    },
  };
}
