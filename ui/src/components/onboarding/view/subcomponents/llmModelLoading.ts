import type { ApiModelListItem } from "../../../../shared/modelListApi";
import type { CatalogProvider, CatalogProviderProtocol } from "../../../../shared/catalogProviders";

const PLACEHOLDER_API_KEY = "PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE";
const MASKED_SECRET = "********";

export type ModelLoadMode = "auto" | "manual";

export type ModelLoadContext = {
  providerId: string;
  protocol: CatalogProviderProtocol;
  url: string;
  apiKey: string;
  isCustomMode: boolean;
  requiresApiKey: boolean;
};

export function hasUsableApiKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return Boolean(key) && key !== PLACEHOLDER_API_KEY && key !== MASKED_SECRET && !key.startsWith("PLACEHOLDER_");
}

export function requiresApiKey(provider: CatalogProvider | null): boolean {
  return provider?.requiresApiKey !== false;
}

/**
 * The onboarding step always hits the same model-list endpoint; only the
 * base URL and apiKey differ. When the catalog provider exposes a dedicated
 * model list URL and no usable key is attached (auto-load, or a manual fetch
 * from a key-less provider) we use that list URL; otherwise we probe the
 * provider's effective base URL directly.
 */
export function modelUsesRemoteDefault(mode: ModelLoadMode, ctx: ModelLoadContext): boolean {
  const key = ctx.apiKey.trim();
  if (mode === "auto") return !ctx.isCustomMode && !key && ctx.requiresApiKey;
  return !ctx.isCustomMode && !hasUsableApiKey(key);
}

/**
 * Resolve the final model list after applying the provider's bundled-catalog
 * fallback. This reproduces the three call sites (two auto effects + the
 * manual fetch button) so the fallback semantics live in one place.
 */
export function resolveNextModels(
  mode: ModelLoadMode,
  ctx: ModelLoadContext,
  provider: CatalogProvider | null,
  models: ApiModelListItem[],
): ApiModelListItem[] {
  const key = ctx.apiKey.trim();
  if (modelUsesRemoteDefault(mode, ctx)) {
    return models.length > 0 ? models : (provider?.models ?? []);
  }
  if (mode === "auto" && provider && !hasUsableApiKey(key) && models.length === 0) {
    return provider.models;
  }
  return models;
}

export type ModelLoadErrorKind = "remote-default" | "local-fallback" | "error";

export function resolveLoadErrorKind(
  mode: ModelLoadMode,
  ctx: ModelLoadContext,
  provider: CatalogProvider | null,
): ModelLoadErrorKind {
  if (mode === "auto" && modelUsesRemoteDefault(mode, ctx)) return "remote-default";
  if (mode === "auto" && provider && !ctx.requiresApiKey && provider.models.length > 0) return "local-fallback";
  return "error";
}
