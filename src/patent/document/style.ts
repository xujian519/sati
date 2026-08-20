/**
 * 排版参数编译：把结构化 DocumentStyle 扁平化为品牌键，编译为 CSS 变量覆盖。
 * 复用 brandInjector 的 BRAND_KEY_TO_CSS_VAR + buildBrandStyle 编译逻辑，保证单一路径。
 */

import { buildBrandStyle } from "./brandInjector.js";
import type { DocumentBrand, DocumentStyle } from "./types.js";

/**
 * 把结构化 DocumentStyle 扁平化为 DocumentBrand（camelCase 键，对齐 BRAND_KEY_TO_CSS_VAR）。
 * 分组 key → 扁平 key 的命名映射在此显式声明，避免隐式约定。
 */
export function flattenDocumentStyle(style: DocumentStyle): DocumentBrand {
  const out: DocumentBrand = {};
  const set = (key: string, value?: string): void => {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  };

  if (style.fontSize) {
    set("textXs", style.fontSize.xs);
    set("textSm", style.fontSize.sm);
    set("textBase", style.fontSize.base);
    set("textMd", style.fontSize.md);
    set("textLg", style.fontSize.lg);
    set("textXl", style.fontSize.xl);
    set("text2xl", style.fontSize.x2l);
  }
  if (style.leading) {
    set("leadingBody", style.leading.body);
    set("leadingTight", style.leading.tight);
  }
  if (style.page) {
    set("pageMargin", style.page.margin);
    set("bodyPadding", style.page.padding);
    set("bodyMaxWidth", style.page.bodyMaxWidth);
  }
  if (style.spacing) {
    set("sectionGap", style.spacing.sectionGap);
    set("sectionGapLg", style.spacing.sectionGapLg);
  }
  if (style.font) {
    set("fontSerif", style.font.serif);
    set("fontSans", style.font.sans);
    set("fontMono", style.font.mono);
  }
  if (style.color) {
    set("accent", style.color.accent);
    set("accentStrong", style.color.accentStrong);
    set("body", style.color.body);
    set("muted", style.color.muted);
    set("border", style.color.border);
    set("headerBg", style.color.headerBg);
    set("surface", style.color.surface);
    set("zebra", style.color.zebra);
    set("danger", style.color.danger);
    set("warning", style.color.warning);
    set("success", style.color.success);
  }
  if (style.brand) {
    set("firm", style.brand.firm);
    set("confidential", style.brand.confidential);
    set("disclaimer", style.brand.disclaimer);
  }
  return out;
}

/** 把 DocumentStyle 编译为可注入 HTML <head> 的 CSS 覆盖文本（:root { --sati-doc-*: ...; }）。 */
export function buildStyleOverrides(style: DocumentStyle): string {
  return buildBrandStyle(flattenDocumentStyle(style));
}

/** 分组级深合并：override 覆盖 base（两层结构：分组 → key）。 */
export function mergeDocumentStyle(base: DocumentStyle, override?: DocumentStyle): DocumentStyle {
  if (override === undefined) return base;
  const out: DocumentStyle = {};
  const groups = ["fontSize", "leading", "page", "spacing", "font", "color", "brand"] as const;
  for (const group of groups) {
    const b = base[group];
    const o = override[group];
    if (b !== undefined || o !== undefined) {
      (out as Record<string, unknown>)[group] = { ...(b ?? {}), ...(o ?? {}) };
    }
  }
  return out;
}

/** DocumentStyle 的 JSON Schema（供工具 inputSchema 与前端调参面板复用）。 */
export const DOCUMENT_STYLE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    fontSize: {
      type: "object",
      additionalProperties: false,
      properties: {
        xs: { type: "string", description: "小五 9pt（页脚/免责小注）" },
        sm: { type: "string", description: "五号 10.5pt（表格/元数据）" },
        base: { type: "string", description: "小四 12pt（正文）" },
        md: { type: "string", description: "H4 标题字号" },
        lg: { type: "string", description: "H3 标题字号" },
        xl: { type: "string", description: "H2 节标题字号" },
        x2l: { type: "string", description: "H1 主标题字号" },
      },
    },
    leading: {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "string", description: "正文行距（如 1.5）" },
        tight: { type: "string", description: "紧凑行距（如 1.3）" },
      },
    },
    page: {
      type: "object",
      additionalProperties: false,
      properties: {
        margin: { type: "string", description: "页边距（如 20mm 25mm 20mm 25mm）" },
        padding: { type: "string", description: "正文内边距（如 0 25mm）" },
        bodyMaxWidth: { type: "string", description: "正文最大宽度（如 160mm）" },
      },
    },
    spacing: {
      type: "object",
      additionalProperties: false,
      properties: {
        sectionGap: { type: "string", description: "节间距" },
        sectionGapLg: { type: "string", description: "大节间距" },
      },
    },
    font: {
      type: "object",
      additionalProperties: false,
      properties: {
        serif: { type: "string", description: "正文字体族（仿宋）" },
        sans: { type: "string", description: "标题字体族（黑体）" },
        mono: { type: "string", description: "等宽字体族（编号/公开号）" },
      },
    },
    color: {
      type: "object",
      additionalProperties: false,
      properties: {
        accent: { type: "string" },
        accentStrong: { type: "string" },
        body: { type: "string" },
        muted: { type: "string" },
        border: { type: "string" },
        headerBg: { type: "string" },
        surface: { type: "string" },
        zebra: { type: "string" },
        danger: { type: "string" },
        warning: { type: "string" },
        success: { type: "string" },
      },
    },
    brand: {
      type: "object",
      additionalProperties: false,
      properties: {
        firm: { type: "string", description: "事务所名称" },
        confidential: { type: "string", description: "密级标记" },
        disclaimer: { type: "string", description: "免责声明" },
      },
    },
  },
};
