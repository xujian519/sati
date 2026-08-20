/**
 * DocumentStyle 扁平化 → CSS 变量覆盖文本。
 * 与后端 src/patent/document/style.ts（flattenDocumentStyle + buildBrandStyle）
 * 保持同一映射，保证前端预览与后端 render_patent_document(style=...) 渲染一致。
 */

import type { DocumentStyle } from "../types";

/** 分组 key → 扁平 key → CSS 变量名（对齐后端 BRAND_KEY_TO_CSS_VAR）。 */
const GROUP_TO_FLAT_KEY: Record<keyof DocumentStyle, Array<[string, string]>> = {
  fontSize: [
    ["xs", "textXs"],
    ["sm", "textSm"],
    ["base", "textBase"],
    ["md", "textMd"],
    ["lg", "textLg"],
    ["xl", "textXl"],
    ["x2l", "text2xl"],
  ],
  leading: [
    ["body", "leadingBody"],
    ["tight", "leadingTight"],
  ],
  page: [
    ["margin", "pageMargin"],
    ["padding", "bodyPadding"],
    ["bodyMaxWidth", "bodyMaxWidth"],
  ],
  spacing: [
    ["sectionGap", "sectionGap"],
    ["sectionGapLg", "sectionGapLg"],
  ],
  font: [
    ["serif", "fontSerif"],
    ["sans", "fontSans"],
    ["mono", "fontMono"],
  ],
  color: [
    ["accent", "accent"],
    ["accentStrong", "accentStrong"],
    ["body", "body"],
    ["muted", "muted"],
    ["border", "border"],
    ["headerBg", "headerBg"],
    ["surface", "surface"],
    ["zebra", "zebra"],
    ["danger", "danger"],
    ["warning", "warning"],
    ["success", "success"],
  ],
  brand: [
    ["firm", "firm"],
    ["confidential", "confidential"],
    ["disclaimer", "disclaimer"],
  ],
};

const FLAT_KEY_TO_CSS_VAR: Record<string, string> = {
  textXs: "--sati-doc-text-xs",
  textSm: "--sati-doc-text-sm",
  textBase: "--sati-doc-text-base",
  textMd: "--sati-doc-text-md",
  textLg: "--sati-doc-text-lg",
  textXl: "--sati-doc-text-xl",
  text2xl: "--sati-doc-text-2xl",
  leadingBody: "--sati-doc-leading-body",
  leadingTight: "--sati-doc-leading-tight",
  pageMargin: "--sati-doc-page-margin",
  bodyPadding: "--sati-doc-body-padding",
  bodyMaxWidth: "--sati-doc-body-max-width",
  sectionGap: "--sati-doc-section-gap",
  sectionGapLg: "--sati-doc-section-gap-lg",
  fontSerif: "--sati-doc-font-serif",
  fontSans: "--sati-doc-font-sans",
  fontMono: "--sati-doc-font-mono",
  accent: "--sati-doc-accent",
  accentStrong: "--sati-doc-accent-strong",
  body: "--sati-doc-body",
  muted: "--sati-doc-muted",
  border: "--sati-doc-border",
  headerBg: "--sati-doc-header-bg",
  surface: "--sati-doc-surface",
  zebra: "--sati-doc-zebra",
  danger: "--sati-doc-danger",
  warning: "--sati-doc-warning",
  success: "--sati-doc-success",
  firm: "--sati-doc-firm",
  confidential: "--sati-doc-confidential",
  disclaimer: "--sati-doc-disclaimer",
};

/** 文案类变量需要 CSS 引号（机构名/密级/免责声明）。 */
const QUOTED_VARS = new Set(["--sati-doc-firm", "--sati-doc-confidential", "--sati-doc-disclaimer"]);

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** 对 CSS 值做最小转义（对齐后端 cssValueEscape）。 */
function cssValueEscape(value: string): string {
  return value.replace(/[{};]/g, "").replace(/\\/g, "\\\\").replace(/\n/g, "\\A ");
}

/**
 * 把 DocumentStyle 扁平化为扁平键映射（去掉空值）。
 * 结果可直接用于 style JSON 序列化（发给 agent 保存预设/重渲染）。
 */
export function flattenDocumentStyle(style: DocumentStyle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, pairs] of Object.entries(GROUP_TO_FLAT_KEY) as Array<
    [keyof DocumentStyle, Array<[string, string]>]
  >) {
    const groupValue = style[group];
    if (groupValue === undefined) continue;
    for (const [subKey, flatKey] of pairs) {
      const value = (groupValue as Record<string, string | undefined>)[subKey];
      if (isNonEmpty(value)) out[flatKey] = value;
    }
  }
  return out;
}

/** 生成可注入 HTML <head> 的 CSS 覆盖文本（:root { --sati-doc-*: ...; }）。 */
export function buildStyleOverridesCss(style: DocumentStyle): string {
  const flat = flattenDocumentStyle(style);
  if (Object.keys(flat).length === 0) return "";
  const lines = [":root {"];
  for (const [flatKey, value] of Object.entries(flat)) {
    const cssVar = FLAT_KEY_TO_CSS_VAR[flatKey];
    if (cssVar === undefined) continue;
    const formatted = QUOTED_VARS.has(cssVar)
      ? `"${cssValueEscape(value).replace(/"/g, '\\"')}"`
      : cssValueEscape(value);
    lines.push(`  ${cssVar}: ${formatted};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** 把样式覆盖注入 HTML 的 <head>（放在现有 <style> 之前，确保覆盖默认变量）。 */
export function injectStyleCssIntoHtml(html: string, css: string): string {
  if (css.trim() === "") return html;
  const style = `<style>\n${css}\n</style>`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + "\n" + style + "\n" + html.slice(insertAt);
  }
  return style + "\n" + html;
}
