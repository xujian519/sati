/**
 * 专利文书渲染核心：模板 HTML + 品牌注入 + 按 id 替换内容 + HTML/PDF 落盘。
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { caseOutputsDir } from "../paths.js";
import { buildBrandStyle, loadBrandFromPath, mergeBrand } from "./brandInjector.js";
import { renderPdf } from "./pdfRenderer.js";
import { readTemplateHtml } from "./templateResolver.js";
import type { DocumentRenderInput, DocumentRenderResult, RenderFormat } from "./types.js";

/** 默认品牌配置文件路径（相对仓库根）。 */
const DEFAULT_BRAND_PATH = "products/_example/brand/theme.json";

/** 安全文件名：字母、数字、下划线、连字符、点；禁止路径分隔符。 */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function sanitizeOutputName(name: string): string {
  if (!SAFE_NAME_PATTERN.test(name)) {
    throw new Error(`非法输出文件名: ${JSON.stringify(name)}`);
  }
  return name;
}

function resolveOutputDir(input: DocumentRenderInput, cwd: string): string {
  if (input.outputDir !== undefined) {
    return isAbsolute(input.outputDir) ? input.outputDir : resolve(cwd, input.outputDir);
  }
  if (input.caseId !== undefined) {
    return resolve(cwd, caseOutputsDir(input.caseId));
  }
  return resolve(cwd, ".sati", "documents");
}

function resolveBrandPath(input: DocumentRenderInput, cwd: string): string | undefined {
  if (input.brandPath !== undefined) {
    return isAbsolute(input.brandPath) ? input.brandPath : resolve(cwd, input.brandPath);
  }
  const fallback = resolve(cwd, DEFAULT_BRAND_PATH);
  return fallback;
}

/** 原子写文件（先 tmp 再 rename）。 */
async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
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

/** 将 sections 按元素 id 替换为 innerHTML。 */
function injectSections(html: string, sections: Record<string, string>): string {
  let result = html;
  for (const [id, content] of Object.entries(sections)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    // 匹配 id="<id>" 或 id='<id>' 的元素，保留外层标签只替换内部。
    const pattern = new RegExp(`(<[^>]+id=["']${id}["'][^>]*>)([\\s\\S]*?)(</[^>]+>)`, "i");
    result = result.replace(pattern, (_match, open: string, _inner: string, close: string) => {
      return `${open}${content}${close}`;
    });
  }
  return result;
}

/** 渲染并落盘。 */
export async function renderPatentDocument(
  input: DocumentRenderInput,
  cwd: string,
): Promise<DocumentRenderResult & { pdfError?: string }> {
  const outputDir = resolveOutputDir(input, cwd);
  await mkdir(outputDir, { recursive: true });

  const name = sanitizeOutputName(input.outputName);
  const htmlPath = join(outputDir, `${name}.html`);
  const pdfPath = join(outputDir, `${name}.pdf`);

  const brandPath = resolveBrandPath(input, cwd);
  const fromConfig = loadBrandFromPath(brandPath);
  const brand = mergeBrand(input.brand, fromConfig);

  let html = readTemplateHtml(input.template);
  html = injectBrandCss(html, buildBrandStyle(brand));
  html = injectSections(html, input.sections ?? {});

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

  return { htmlPath, pdfPath: renderedPdfPath, pdfError };
}
