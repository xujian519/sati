import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../../telemetry/index.js";

const logger = createLogger("patent_pdf_download");

/**
 * Google Patents 专利页内提取 PDF CDN 链接的浏览器侧 JS（buildDownloadScript 内嵌）。
 * P2-07：唯一事实源为 assets/patent/pdf-link-extract.js（每次 execute 热加载）；
 * 本常量为内嵌回退备份（文件缺失时使用，内容须与文件一致）。
 */
const PDF_LINK_EXTRACT_JS = String.raw`(() => {
  const links = document.querySelectorAll('a[href*=".pdf"]');
  for (const link of links) {
    if (link.href && (link.href.includes('storage.googleapis.com') || link.href.includes('patentimages'))) return link.href;
  }
  for (const link of links) { if (link.href) return link.href; }
  // Google Patents 新版把 PDF URL 放在某些 data 属性或按钮附近，兜底扫描全部 href
  const allLinks = [...document.querySelectorAll('a[href]')];
  for (const link of allLinks) {
    if (link.href && (link.href.includes('.pdf') || link.href.includes('download'))) return link.href;
  }
  return null;
})()`;

/**
 * P2-07：加载单一事实源 assets/patent/pdf-link-extract.js（每次构建脚本时热加载，
 * 改动无需重新构建）。源码态（src/tool/builtin/）上溯 3 级到仓库根，dist 态
 * （dist/src/tool/builtin/）上溯 4 级；两处候选都缺失时回退内嵌备份。
 */
export async function loadPdfLinkExtractJs(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "assets", "patent", "pdf-link-extract.js"),
    join(here, "..", "..", "..", "..", "assets", "patent", "pdf-link-extract.js"),
  ];
  for (const candidate of candidates) {
    try {
      const js = await readFile(candidate, "utf8");
      // 与 Python 端对齐：首行须为版本标记，否则视为损坏回退内嵌备份。
      // CRLF 检出（Windows autocrlf）下首行尾含 \r，按行尾容错匹配。
      if (/^\/\/ PDF_LINK_EXTRACT_VERSION=\d+\r?$/.test(js.split(/\r?\n/, 1)[0] ?? "")) {
        return js;
      }
      logger.warn(`${candidate} 缺少 PDF_LINK_EXTRACT_VERSION 版本标记，回退内嵌备份`);
    } catch {
      // 候选路径不可读：继续下一个候选，全部失败回退内嵌备份（fail-safe）。
    }
  }
  return PDF_LINK_EXTRACT_JS;
}

/**
 * 嵌入 String.raw 模板前的防御性转义：反引号与 `${` 会截断模板字面量。
 * 反斜杠刻意不转义（会破坏 JS 正则语义，如 `/\d+/`）；资产注释已声明内容
 * 不得含反引号/插值占位符，本转义 + 版本标记校验为编辑违约时的兜底。
 */
export function escapeTemplateContent(js: string): string {
  return js.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** 探测页面是否存在 "Download PDF" 按钮/链接（不点击）。 */
export const FIND_DOWNLOAD_PDF_JS = String.raw`(() => {
  const candidates = [...document.querySelectorAll('a, button, [role="button"], input[type="button"]')];
  return candidates.some(el => {
    const text = (el.innerText || el.textContent || el.value || el.title || '').toLowerCase();
    return text.includes('download pdf') || (text.includes('download') && text.includes('pdf'));
  });
})()`;

/** 点击页面上的 "Download PDF" 按钮/链接（Google Patents 当前是 JS 触发的空 href 元素）。 */
export const CLICK_DOWNLOAD_PDF_JS = String.raw`(() => {
  const candidates = [...document.querySelectorAll('a, button, [role="button"], input[type="button"]')];
  const btn = candidates.find(el => {
    const text = (el.innerText || el.textContent || el.value || el.title || '').toLowerCase();
    return text.includes('download pdf') || (text.includes('download') && text.includes('pdf'));
  });
  if (!btn) return null;
  btn.click();
  return btn.tagName + (btn.innerText ? ':' + btn.innerText.trim().slice(0, 30) : '');
})()`;
