/**
 * 流式 HTTP 传输常量（单一来源）。
 *
 * 供 streamModel（LiteLLM 流式请求）与 proxy（Undici 连接池参数）共享，
 * 避免同一组数值在两个模块各自内联导致漂移。
 */

/** 流式完成 HTTP 兜底超时（ms）。 */
export const LITELLM_COMPLETION_HTTP_FALLBACK_MS = 600_000;
/** Undici 全局连接数上限。 */
export const LITELLM_HTTP_CONNECTOR_LIMIT = 1000;
/** Undici keep-alive 超时（ms）。 */
export const LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS = 120_000;
