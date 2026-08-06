/**
 * `not_configured` 降级结果构造（gateway 可选能力未接线时的统一出口）。
 *
 * InProcessGateway 与 GatewayWsConnection 的可选方法（always_on_* /
 * knowledge_capabilities）共用同一错误字面量形状，避免各方法各自拼写
 * `{ ..., error: { code: "not_configured", message } }` 造成漂移。
 * 调用方只需提供各自结果类型的占位字段与错误文案。
 */

export type NotConfiguredResult<T extends object> = T & {
  error: { code: "not_configured"; message: string };
};

export function notConfigured<T extends object>(payload: T, message: string): NotConfiguredResult<T> {
  return { ...payload, error: { code: "not_configured", message } };
}
