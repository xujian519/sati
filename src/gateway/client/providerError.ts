/**
 * src/gateway/client — provider 错误映射（纯函数）。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮次 1）：AgentError / CanonicalModelError /
 * 泛化记录 → GatewayEvent.providerError 的形状映射与字段守卫。
 */

import type { AgentError } from "../../agent/index.js";
import type { CanonicalModelError } from "../../model/index.js";
import type { GatewayEvent } from "../protocol/types.js";

export type GatewayEventProviderError = NonNullable<Extract<GatewayEvent, { type: "error" }>["providerError"]>;

export function providerErrorFromAgentError(error: AgentError): GatewayEventProviderError | undefined {
  const details = error.details;
  if (!details || typeof details !== "object") return undefined;
  return providerErrorFromRecord(details as Record<string, unknown>);
}

export function providerErrorFromModelError(error: CanonicalModelError): GatewayEventProviderError {
  return {
    provider: error.provider,
    protocol: error.protocol,
    status: error.status,
    code: error.code,
    message: error.message,
    raw: stringifyProviderRaw(error.raw),
  };
}

export function providerErrorFromRecord(details: Record<string, unknown>): GatewayEventProviderError | undefined {
  const provider = stringOrUndefined(details.provider);
  const protocol = stringOrUndefined(details.protocol);
  const status = numberOrUndefined(details.status);
  const code = stringOrUndefined(details.code);
  const message = stringOrUndefined(details.message);
  const raw = stringifyProviderRaw(details.raw);
  if (!provider && !protocol && status === undefined && !code && !message && !raw) return undefined;
  return { provider, protocol, status, code, message, raw };
}

export function stringifyProviderRaw(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "string" ? raw : safeJsonStringify(raw);
  if (!text) return undefined;
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // 序列化失败（循环引用等）回退 String 表示，调用方仍可获得可见信息。
    return String(value);
  }
}
