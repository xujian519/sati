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
 * 发布门控（D6）：是否允许把 HTML 标注写成 `kind:"html"` 侧车。
 *
 * 2026-10-23 起默认开启（#624）：工作区读者已确认可识别 `kind:"html"`（H1 契约层，
 * Sati ≥ v0.3.6；dsh 读侧保留标注、按 `mediaType` 往返）。旧版 Sati（< H1）会把未知
 * kind 视为「从未标注」并在保存时静默覆盖，因此在仍有多版本共存的环境里须显式置
 * `VITE_ENABLE_HTML_ANNOTATION=false`（或 `0`）关闭写入。
 * 见 docs/notes/implemented/2026-10-23-html-annotation-gate-opened.md。
 *
 * 函数而非常量：读取时机在调用点，测试与运行时都可按环境判定。
 */
export function isHtmlAnnotationKindWriteEnabled(): boolean {
  const flag = import.meta.env.VITE_ENABLE_HTML_ANNOTATION;
  return flag !== "false" && flag !== "0";
}
