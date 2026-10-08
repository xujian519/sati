/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = import.meta.env.VITE_IS_PLATFORM === "true";

/**
 * Matches server SATI_DISABLE_LOCAL_AUTH (injected in vite.config.js).
 */
export const DISABLE_LOCAL_AUTH = import.meta.env.VITE_DISABLE_LOCAL_AUTH === "true";

/**
 * 发布门控（D6）：是否允许把 HTML 标注写成 `kind:"html"` 侧车，默认关闭。
 *
 * 旧版 Sati 读到未知 kind 会视为「从未标注」，并在保存时静默覆盖（H0 #6 实测，
 * 见 docs/notes/proposed/2026-10-08-html-annotation.md）。仅当确认所有读者
 * （dsh 与各版本 Sati）已升级后，才可用 `VITE_ENABLE_HTML_ANNOTATION=true` 开启。
 *
 * 函数而非常量：读取时机在调用点，测试与运行时都可按环境判定。
 */
export function isHtmlAnnotationKindWriteEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_HTML_ANNOTATION === "true";
}
