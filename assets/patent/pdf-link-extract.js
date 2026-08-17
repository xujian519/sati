// PDF_LINK_EXTRACT_VERSION=1
// 单一事实源：patentPdfDownload.ts（TS 工具）与 download_patent_ego.py（Python 脚本）
// 共用本文件提取 Google Patents 页面的 PDF CDN 链接。改动必须同步版本号；
// 两端各自保留内嵌备份（文件缺失时回退），备份内容须与本文件一致。
// 约束：内容不得包含反引号字符，也不得包含模板插值占位符（美元符号紧接左大括号），
// 两端以 String.raw 模板嵌入，出现即截断模板字面量。
(() => {
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
})()
