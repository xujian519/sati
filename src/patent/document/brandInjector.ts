/**
 * 品牌注入：读取 products/<产品>/brand/theme.json 并映射为 CSS 变量。
 *
 * assets/templates/patent/*.html 使用 :root 上的 --sati-doc-* 变量；
 * 事务所/白标产品通过 theme.json 的 documents.patent 命名空间覆盖。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DocumentBrand } from "./types.js";

/** theme.json -> documents.patent 的已知键到 CSS 变量名的映射。 */
export const BRAND_KEY_TO_CSS_VAR: Record<string, string> = {
  firm: "--sati-doc-firm",
  confidential: "--sati-doc-confidential",
  disclaimer: "--sati-doc-disclaimer",
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
  evidence: "--sati-doc-evidence",
  client: "--sati-doc-client",
  model: "--sati-doc-model",
  assumption: "--sati-doc-assumption",
  fontSerif: "--sati-doc-font-serif",
  fontSans: "--sati-doc-font-sans",
  fontMono: "--sati-doc-font-mono",
  // 排版尺度（v2 排版规范：小四 12pt 正文 + 仿宋 + 1.5 行距）
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
};

/** 纯字符串值是否需要 CSS 引号（颜色/字体以外的文案类变量）。 */
const QUOTED_VARS = new Set(["--sati-doc-firm", "--sati-doc-confidential", "--sati-doc-disclaimer"]);

/** 从任意路径读取 theme.json 并提取 documents.patent 品牌覆盖。 */
export function loadBrandFromPath(path?: string): DocumentBrand {
  if (path === undefined) return {};
  const abs = resolve(path);
  if (!existsSync(abs)) return {};
  try {
    const raw = readFileSync(abs, "utf8");
    const parsed = JSON.parse(raw) as { documents?: { patent?: DocumentBrand } };
    return parsed.documents?.patent ?? {};
  } catch {
    return {};
  }
}

/** 合并多层品牌覆盖：默认 < 配置文件 < 显式传入。 */
export function mergeBrand(explicit?: DocumentBrand, fromConfig?: DocumentBrand): DocumentBrand {
  return { ...(fromConfig ?? {}), ...(explicit ?? {}) };
}

/** 将品牌对象编译为一段可注入 HTML <style> 的 CSS 文本。 */
export function buildBrandStyle(brand: DocumentBrand): string {
  const lines: string[] = [":root {"];
  for (const [key, value] of Object.entries(brand)) {
    const cssVar = BRAND_KEY_TO_CSS_VAR[key];
    // 跳过未知键与空值（空串/纯空白会生成 `--x: ;` 无效声明）。
    if (cssVar === undefined || value === undefined || value.trim() === "") continue;
    // 文案类变量作为 CSS 字符串（外层加引号 + 内部转义引号）；其余（颜色/字体/字号/页边距）保留原值。
    const formatted = QUOTED_VARS.has(cssVar)
      ? `"${cssValueEscape(value).replace(/"/g, '\\"')}"`
      : cssValueEscape(value);
    lines.push(`  ${cssVar}: ${formatted};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * 对 CSS 值做最小转义：未引号值（颜色/字体等）剔除会破坏 CSS 结构的
 * 分号与花括号，并转义反斜杠；引号值额外转义双引号与换行。
 */
function cssValueEscape(value: string): string {
  // 剔除会破坏 CSS 结构的字符；引号不在此转义——字体族等值需保留合法引号（如 "FangSong", "仿宋"）。
  return value.replace(/[{};]/g, "").replace(/\\/g, "\\\\").replace(/\n/g, "\\A ");
}
