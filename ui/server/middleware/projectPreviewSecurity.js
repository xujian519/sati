/**
 * 项目预览路由的响应安全头（P0：凭据外泄修复的第二道防线）。
 *
 * 预览路由把项目里的 HTML 原样流式输出，文档脚本与应用同属一个服务端来源。两条防线：
 *
 * - `sandbox`（CSP 指令形式）：让文档即使被**顶层打开**（新标签页）也是不透明源——
 *   它读不到应用源的 localStorage / cookie，也不能以应用身份调用 API。
 *   iframe 的 `sandbox` 属性只约束嵌入场景，这条头补上直开场景。
 * - `connect-src 'none'`：脚本无法 fetch / XHR / WebSocket 外发任意数据。
 *
 * 脚本与样式仍允许 `unsafe-inline` 与 `'self'`（项目内 sibling 资源），外部主机只放行
 * `PROJECT_PREVIEW_EXTERNAL_HOSTS` 中的 CDN：这是 Sati HTML 交付物（内联脚本 + Chart.js /
 * 字体）的既有依赖，不是放宽。
 */

/** 允许加载的外部主机（Chart.js、Google Fonts）。新增主机须走决策记录。 */
export const PROJECT_PREVIEW_EXTERNAL_HOSTS = Object.freeze({
  scripts: ["https://cdn.jsdelivr.net"],
  styles: ["https://fonts.googleapis.com"],
  fonts: ["https://fonts.gstatic.com"],
});

const { scripts, styles, fonts } = PROJECT_PREVIEW_EXTERNAL_HOSTS;

/**
 * 可被浏览器渲染为脚本文档的 MIME 类型。同源导航到这些响应时，若不带沙箱策略，
 * 文档就会以应用源运行（见 files/content 路由）。
 */
const ACTIVE_DOCUMENT_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);

/**
 * 必须强制下载、不得以文档渲染的 MIME 类型。
 *
 * `.mht/.mhtml`（`message/rfc822`）不在沙箱 MIME 集合内：Chromium 对 MHTML 导航本就要
 * 提交为不透明源，但跨引擎行为存在不确定性，统一改为 `Content-Disposition: attachment`，
 * 从渲染面移除而不是依赖浏览器实现细节。
 */
const FORCE_ATTACHMENT_MIME_TYPES = new Set(["message/rfc822"]);

/** 预览文档的 Content-Security-Policy。'self' 允许项目内的同目录资源（sibling JS/CSS/字体）。 */
export const PROJECT_PREVIEW_CSP = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups",
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' ${scripts.join(" ")}`,
  `style-src 'self' 'unsafe-inline' ${styles.join(" ")}`,
  `font-src 'self' data: ${fonts.join(" ")}`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * 给预览响应补齐安全头。
 *
 * @param {import("express").Response} res - 预览响应。
 */
export function applyProjectPreviewSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", PROJECT_PREVIEW_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 文档内的子资源请求不得把预览 URL（含凭据参数）当作 Referer 发出。
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * 判断一个 MIME 类型是否可被渲染为脚本文档（须加沙箱策略）。
 *
 * @param {string | null | undefined} mimeType - Content-Type（可带参数，如 `; charset=utf-8`）。
 * @returns {boolean} 是否为脚本文档类型。
 */
export function isActiveDocumentMimeType(mimeType) {
  if (typeof mimeType !== "string") return false;
  return ACTIVE_DOCUMENT_MIME_TYPES.has(mimeType.split(";")[0].trim().toLowerCase());
}

/**
 * 判断一个 MIME 类型是否必须强制下载（不得以文档渲染）。
 *
 * @param {string | null | undefined} mimeType - Content-Type（可带参数）。
 * @returns {boolean} 是否强制下载。
 */
export function shouldForceAttachment(mimeType) {
  if (typeof mimeType !== "string") return false;
  return FORCE_ATTACHMENT_MIME_TYPES.has(mimeType.split(";")[0].trim().toLowerCase());
}

/**
 * 项目原始文件（files/content）的响应安全头。
 *
 * - 所有项目文件：`nosniff`，禁止浏览器把数据猜测成可执行类型。
 * - 可渲染为脚本文档的类型（HTML / SVG / XML）：附带与预览相同的沙箱 CSP，
 *   使同源导航到它的文档也是不透明源，无法以应用身份调用 API。
 *   图片、PDF 等非文档类型不加沙箱头，避免影响 `<img>` 与 pdf.js 的渲染。
 *
 * @param {import("express").Response} res - 响应。
 * @param {string} mimeType - 即将返回的 Content-Type。
 */
export function applyProjectFileSecurityHeaders(res, mimeType) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (isActiveDocumentMimeType(mimeType)) {
    res.setHeader("Content-Security-Policy", PROJECT_PREVIEW_CSP);
    res.setHeader("Referrer-Policy", "no-referrer");
  }
}
