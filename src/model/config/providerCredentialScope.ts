import type { ModelProtocol } from "../protocol/canonical.js";

/**
 * Catalog 凭证作用域（2026-09，移植自 PilotDeck #546 语义）。
 *
 * catalog 的 `apiKeyEnvVar`（如 ANTHROPIC_API_KEY）仅在 provider 仍使用
 * catalog 条目的协议与端点时才允许自动注入；一旦用户把 url（或协议）指
 * 向自定义端点，静默读取 catalog 环境变量会把密钥发往第三方 URL——这是
 * 凭证泄漏面。用户显式填写的 apiKey（字面量或 `${VAR}` 引用）是有意
 * 选择，对任意端点均有效，不受本模块限制。
 */

export type CatalogCredentialRef = {
  protocol: ModelProtocol;
  defaultUrl: string;
};

export type CatalogCredentialScopeInput = {
  providerId: string;
  /** 用户/catalog 合并后的最终协议（parse 结果）。 */
  protocol: ModelProtocol;
  /** 用户/catalog 默认值合并后的最终 url（parse 结果）。 */
  url: string;
  catalog: CatalogCredentialRef | undefined;
};

/** 端点比较的规范化形态：URL 解析 + 剥尾部斜杠；非法值归一为空串。 */
function canonicalProviderUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function protocolCanUseCatalogCredential(
  providerId: string,
  protocol: ModelProtocol,
  catalogProtocol: ModelProtocol,
): boolean {
  if (protocol === catalogProtocol) return true;
  // Google 官方 OpenAI 兼容端点仍属 catalog 凭证的合法作用域。
  return providerId === "google" && protocol === "openai" && catalogProtocol === "google";
}

/**
 * 解析 provider 默认 url（含 Google 的官方 OpenAI 兼容端点例外）。
 * 配置解析（默认 url）与凭证作用域判断共用此函数，保证两者判定永不漂移。
 */
export function resolveDefaultProviderUrl(
  providerId: string,
  protocol: ModelProtocol,
  catalogDefaultUrl: string | undefined,
): string | undefined {
  if (providerId === "google" && protocol === "openai") {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  return catalogDefaultUrl;
}

/**
 * catalog 凭证环境变量是否可对该 provider 自动生效：
 * 解析后的协议与 url 仍与 catalog 条目一致（含 Google OpenAI 兼容例外）。
 */
export function canUseCatalogCredential(input: CatalogCredentialScopeInput): boolean {
  const catalog = input.catalog;
  if (!catalog || !catalog.defaultUrl) return false;
  if (!protocolCanUseCatalogCredential(input.providerId, input.protocol, catalog.protocol)) return false;
  const expected = canonicalProviderUrl(
    resolveDefaultProviderUrl(input.providerId, input.protocol, catalog.defaultUrl) ?? "",
  );
  const actual = canonicalProviderUrl(input.url);
  return expected !== "" && actual === expected;
}
