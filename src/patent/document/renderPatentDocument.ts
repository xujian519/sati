/**
 * 专利文书渲染核心：模板 HTML + 品牌注入 + 按 id 替换内容 + HTML/PDF 落盘。
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { caseOutputsDir } from "../paths.js";
import { buildBrandStyle, loadBrandFromPath, mergeBrand } from "./brandInjector.js";
import { buildStyleOverrides, mergeDocumentStyle } from "./style.js";
import { loadStylePreset, resolvePresetDirFromBrandPath } from "./stylePreset.js";
import { SatiDocumentInputError } from "./errors.js";
import { renderPdf } from "./pdfRenderer.js";
import { readTemplateHtml } from "./templateResolver.js";
import type { DocumentRenderInput, DocumentRenderResult, DocumentStyle, RenderFormat } from "./types.js";

/** 默认品牌配置文件路径（相对仓库根）。 */
const DEFAULT_BRAND_PATH = "products/_example/brand/theme.json";

/** 安全文件名：字母、数字、下划线、连字符、点；禁止路径分隔符。 */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 安全案卷号：同上，允许中文，且不含 `..` 段（防路径穿越）。 */
const SAFE_CASE_ID_PATTERN = /^(?!.*\.\.)[A-Za-z0-9._\-\u4e00-\u9fa5]{1,120}$/;

function sanitizeOutputName(name: string): string {
  if (!SAFE_NAME_PATTERN.test(name)) {
    throw new SatiDocumentInputError(`非法输出文件名: ${JSON.stringify(name)}`);
  }
  return name;
}

function sanitizeCaseId(caseId: string): string {
  if (!SAFE_CASE_ID_PATTERN.test(caseId)) {
    throw new SatiDocumentInputError(`非法案卷号: ${JSON.stringify(caseId)}`);
  }
  return caseId;
}

function resolveOutputDir(input: DocumentRenderInput, cwd: string): string {
  if (input.outputDir !== undefined) {
    return isAbsolute(input.outputDir) ? input.outputDir : resolve(cwd, input.outputDir);
  }
  if (input.caseId !== undefined) {
    return resolve(cwd, caseOutputsDir(sanitizeCaseId(input.caseId)));
  }
  return resolve(cwd, ".sati", "documents");
}

function resolveBrandPath(input: DocumentRenderInput, cwd: string): { path: string; explicit: boolean } {
  if (input.brandPath !== undefined) {
    return { path: isAbsolute(input.brandPath) ? input.brandPath : resolve(cwd, input.brandPath), explicit: true };
  }
  return { path: resolve(cwd, DEFAULT_BRAND_PATH), explicit: false };
}

/** 原子写文件（先 tmp 再 rename；Windows 上 rename 不覆盖已存在文件，先清理目标）。 */
async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
  await rm(file, { force: true });
  await rename(tmp, file);
}

/** 将品牌 CSS 注入到 HTML 的 <head>（放在现有 <style> 之前，确保覆盖默认变量）。 */
function injectBrandCss(html: string, brandCss: string): string {
  const style = `<style>\n${brandCss}\n</style>`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + "\n" + style + "\n" + html.slice(insertAt);
  }
  return style + "\n" + html;
}

/** HTML void 元素（无闭合标签），标签配平扫描时跳过。 */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * 从开标签结束位置向后扫描，找到与之配对的闭合标签起始下标。
 * 用全标签深度计数处理嵌套内容（模板为受控的良构 HTML）。
 */
function findMatchingCloseTag(html: string, openEnd: number): number | undefined {
  const tagRe = /<\/?[A-Za-z][^>]*>/g;
  tagRe.lastIndex = openEnd;
  let depth = 1; // 开标签本身计入深度
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const token = match[0];
    const isClose = token.startsWith("</");
    const nameMatch = token.match(/^<\/?([A-Za-z][A-Za-z0-9]*)/);
    const name = (nameMatch ? nameMatch[1] : "").toLowerCase();
    if (isClose) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      if (VOID_TAGS.has(name) || /\/>$/.test(token)) continue;
      depth += 1;
    }
  }
  return undefined;
}

/** 将 sections 按元素 id 替换为 innerHTML；返回被跳过（未命中/非法）的 id。 */
function injectSections(html: string, sections: Record<string, string>): { html: string; skippedIds: string[] } {
  let result = html;
  const skippedIds: string[] = [];
  for (const [id, content] of Object.entries(sections)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      skippedIds.push(id);
      continue;
    }
    const openPattern = new RegExp(`<([A-Za-z][A-Za-z0-9]*)[^>]*id=["']${id}["'][^>]*>`, "i");
    const openMatch = openPattern.exec(result);
    if (openMatch === null) {
      skippedIds.push(id);
      continue;
    }
    const closeStart = findMatchingCloseTag(result, openMatch.index + openMatch[0].length);
    if (closeStart === undefined) {
      skippedIds.push(id);
      continue;
    }
    result = result.slice(0, openMatch.index) + openMatch[0] + content + result.slice(closeStart);
  }
  return { html: result, skippedIds };
}

/** 渲染并落盘。 */
export async function renderPatentDocument(input: DocumentRenderInput, cwd: string): Promise<DocumentRenderResult> {
  const warnings: string[] = [];

  const outputDir = resolveOutputDir(input, cwd);
  await mkdir(outputDir, { recursive: true });

  const name = sanitizeOutputName(input.outputName);
  const htmlPath = join(outputDir, `${name}.html`);
  const pdfPath = join(outputDir, `${name}.pdf`);

  const brandPath = resolveBrandPath(input, cwd);
  if (brandPath.explicit && !existsSync(brandPath.path)) {
    warnings.push(`品牌配置文件不存在，已回退默认: ${brandPath.path}`);
  }
  const fromConfig = loadBrandFromPath(brandPath.path);
  const brand = mergeBrand(input.brand, fromConfig);

  // 加载样式预设（如指定），显式 style 覆盖预设（分组级深合并）。
  let style: DocumentStyle | undefined;
  if (input.stylePreset !== undefined) {
    const presetDir = resolvePresetDirFromBrandPath(brandPath.path);
    const preset = loadStylePreset(presetDir, input.stylePreset);
    style = mergeDocumentStyle(preset.style, input.style);
  } else {
    style = input.style;
  }

  let html = readTemplateHtml(input.template);
  const brandCss = buildBrandStyle(brand);
  const styleCss = style !== undefined ? buildStyleOverrides(style) : "";
  const combinedCss = [brandCss, styleCss].filter(s => s !== "").join("\n");
  html = injectBrandCss(html, combinedCss);
  const injected = injectSections(html, input.sections ?? {});
  html = injected.html;
  if (injected.skippedIds.length > 0) {
    warnings.push(`以下 section id 未命中模板，内容已忽略: ${injected.skippedIds.join(", ")}`);
  }

  await atomicWriteFile(htmlPath, html);

  const format: RenderFormat = input.format ?? "both";
  let renderedPdfPath: string | undefined;
  let pdfError: string | undefined;
  if (format === "pdf" || format === "both") {
    const pdfResult = await renderPdf(htmlPath, pdfPath);
    if (pdfResult.ok) {
      renderedPdfPath = pdfResult.path;
    } else {
      pdfError = pdfResult.error;
    }
  }

  return { htmlPath, pdfPath: renderedPdfPath, pdfError, warnings };
}
