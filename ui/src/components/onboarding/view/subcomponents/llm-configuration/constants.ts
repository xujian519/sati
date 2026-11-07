import { CATALOG_PROVIDERS, type CatalogProvider } from "../../../../../shared/catalogProviders";

// Sentinel id for the "+" tile. When selected, the form swaps in extra inputs
// (provider id, protocol, base URL) so the user can describe a provider that
// isn't in the catalog.
export const CUSTOM_PROVIDER_ID = "__custom__";

export const CUSTOM_PROVIDER: CatalogProvider = {
  id: CUSTOM_PROVIDER_ID,
  displayName: "Custom",
  protocol: "openai",
  defaultUrl: "",
  models: [],
};

// 默认选中 DeepSeek（常用国产模型，API 便宜、注册简单），方便国内用户
// 开箱即用；也可在下方网格切换到 Kimi / GLM / Qwen 等其它内置 Provider。
export const DEFAULT_PROVIDER = CATALOG_PROVIDERS.find(provider => provider.id === "deepseek") ?? CATALOG_PROVIDERS[0];

export function defaultModelForProvider(provider: CatalogProvider | null) {
  if (!provider) return "";
  // DeepSeek provider 的模型 id 无 "deepseek/" 前缀（带前缀的是 OpenRouter 入口）。
  return provider.models.find(model => model.id === "deepseek-v4-flash")?.id ?? provider.models[0]?.id ?? "";
}
