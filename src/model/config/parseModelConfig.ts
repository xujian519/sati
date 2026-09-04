import { ANTHROPIC_DEFAULT_CAPABILITIES, ANTHROPIC_DEFAULT_MULTIMODAL } from "../providers/anthropic/defaults.js";
import { OPENAI_DEFAULT_CAPABILITIES, OPENAI_DEFAULT_MULTIMODAL } from "../providers/openai/defaults.js";
import { GOOGLE_DEFAULT_CAPABILITIES, GOOGLE_DEFAULT_MULTIMODAL } from "../providers/google/defaults.js";
import type {
  ApiKeySource,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
  ProviderRetryConfig,
} from "../protocol/canonical.js";
import { mergeCapabilities, type ModelCapabilities } from "../protocol/capabilities.js";
import { ModelConfigError } from "../protocol/errors.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS, isInputModality, type MultimodalConstraints } from "../protocol/multimodal.js";
import { lookupCatalogModel, lookupCatalogProvider } from "../catalog/index.js";
import { getCachedOllamaModels } from "../ollama/probe.js";
import { canUseCatalogCredential, resolveDefaultProviderUrl } from "./providerCredentialScope.js";
import { isEnvReference, resolveApiKey, type CredentialEnv } from "./resolveCredentials.js";
import {
  isModelProtocol,
  isRecord,
  type RawCapabilities,
  type RawModelConfig,
  type RawModelDefinition,
  type RawMultimodal,
  type RawProviderConfig,
} from "./schema.js";

export type ParseModelConfigOptions = {
  env?: CredentialEnv;
};

export function parseModelConfig(
  rawConfig: RawModelConfig | unknown,
  options: ParseModelConfigOptions = {},
): ModelConfig {
  if (!isRecord(rawConfig)) {
    throw new ModelConfigError("invalid_model_config", "Model config must be an object.");
  }

  if (!isRecord(rawConfig.providers) || Object.keys(rawConfig.providers).length === 0) {
    throw new ModelConfigError("missing_provider", "Model config must contain at least one provider.");
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [providerId, rawProvider] of Object.entries(rawConfig.providers)) {
    const parsed = parseProvider(providerId, rawProvider, options.env);
    if (parsed) {
      providers[providerId] = parsed;
    }
  }

  return {
    providers,
  };
}

/**
 * 判定 provider 是否为"纯占位 stub"：url、apiKey、models 全部为空。
 * 这类条目由配置编辑器产生（新增 provider 行后未填写即保存），不承载
 * 任何可用配置，parseProvider 对它们返回 null 由 parseModelConfig 跳过。
 * 只要有一项有值（例如声明了 models 却漏 url），就按真实配置处理并报错。
 */
function isProviderStub(rawProvider: RawProviderConfig): boolean {
  const url = typeof rawProvider.url === "string" ? rawProvider.url.trim() : "";
  if (url.length > 0) return false;
  const apiKey = typeof rawProvider.apiKey === "string" ? rawProvider.apiKey.trim() : "";
  if (apiKey.length > 0) return false;
  return !isRecord(rawProvider.models) || Object.keys(rawProvider.models).length === 0;
}

function parseProvider(providerId: string, rawProvider: unknown, env?: CredentialEnv): ProviderConfig | null {
  if (!isRecord(rawProvider)) {
    throw new ModelConfigError("invalid_provider", `Provider ${providerId} must be an object.`);
  }

  const provider = rawProvider as RawProviderConfig;
  const catalogProvider = lookupCatalogProvider(providerId);

  const protocol = isModelProtocol(provider.protocol) ? provider.protocol : catalogProvider?.protocol;
  if (!protocol) {
    throw new ModelConfigError("unsupported_protocol", `Provider ${providerId} has unsupported protocol.`, {
      providerId,
      protocol: provider.protocol,
    });
  }

  const trimmedUrl = typeof provider.url === "string" ? provider.url.trim() : "";
  const rawUrl =
    trimmedUrl.length > 0 ? trimmedUrl : resolveDefaultProviderUrl(providerId, protocol, catalogProvider?.defaultUrl);
  if (!rawUrl) {
    // 纯占位 provider（url/apiKey/models 全空，例如配置编辑器里"新增
    // provider"后未填写就保存的空行）没有任何可用配置：跳过而非抛错，
    // 否则一个残留 stub 会让整个 gateway 启动失败。
    if (isProviderStub(provider)) {
      return null;
    }
    throw new ModelConfigError("invalid_config_value", `Provider ${providerId} requires a url.`, { providerId });
  }
  assertValidUrl(rawUrl, providerId);

  let rawModels: Record<string, unknown>;
  if (providerId === "ollama") {
    // Ollama 模型列表由运行时自动识别（探测用户已安装的模型）：探测结果
    // 补全缺失项，配置显式声明的模型优先。空 models 也不再报错、不阻塞启动。
    rawModels = {
      ...resolveOllamaModelsFromCache(rawUrl),
      ...(isRecord(provider.models) ? provider.models : {}),
    };
  } else {
    if (!isRecord(provider.models) || Object.keys(provider.models).length === 0) {
      throw new ModelConfigError("empty_models", `Provider ${providerId} must contain at least one model.`, {
        providerId,
      });
    }
    rawModels = provider.models;
  }

  const models: Record<string, ModelDefinition> = {};
  for (const [modelId, rawModel] of Object.entries(rawModels)) {
    models[modelId] = parseModelDefinition(modelId, protocol, rawModel, providerId);
  }

  // Catalog 凭证作用域：自定义 url/协议下不再自动读取 catalog 环境变量，
  // 否则密钥会被发往第三方端点（凭证泄漏面）。显式 apiKey 不受影响。
  const catalogCredentialUsable = canUseCatalogCredential({
    providerId,
    protocol,
    url: rawUrl,
    catalog: catalogProvider
      ? { protocol: catalogProvider.protocol, defaultUrl: catalogProvider.defaultUrl }
      : undefined,
  });
  if (catalogProvider?.apiKeyEnvVar && !catalogCredentialUsable) {
    const hasExplicitApiKey = typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
    if (!hasExplicitApiKey) {
      throw new ModelConfigError(
        "missing_credential",
        `Provider ${providerId} uses a custom url/protocol, so catalog env ` +
          `${catalogProvider.apiKeyEnvVar} is not applied automatically. ` +
          `Set apiKey explicitly (literal or \`\${${catalogProvider.apiKeyEnvVar}}\`).`,
        { providerId, envName: catalogProvider.apiKeyEnvVar },
      );
    }
  }
  const apiKeyRef = resolveProviderApiKeyRef(
    providerId,
    provider.apiKey,
    env,
    catalogCredentialUsable ? catalogProvider?.apiKeyEnvVar : undefined,
  );
  return {
    id: providerId,
    protocol,
    url: rawUrl,
    apiKey: apiKeyRef.resolved,
    ...(apiKeyRef.raw !== undefined ? { apiKeyRaw: apiKeyRef.raw } : {}),
    apiKeySource: apiKeyRef.source,
    timeoutMs: readOptionalPositiveNumber(provider.timeoutMs, "timeoutMs"),
    headers: readStringRecord(provider.headers, "headers"),
    extraBody: isRecord(provider.extraBody) ? (provider.extraBody as Record<string, unknown>) : undefined,
    retry: parseRetryConfig(provider.retry),
    models,
  };
}

type ApiKeyResolution = {
  /** 一次解析后的密钥（parse 时对 ${VAR} 求值；向后兼容使用点）。 */
  resolved: string;
  /** 原始配置值（字面量或 `${VAR}` 引用；undefined 表示无原始值）。 */
  raw: string | undefined;
  /** 来源：字面量或环境变量引用。 */
  source: ApiKeySource;
};

/**
 * 解析 provider apiKey 并记录原始引用（引用/值分离）。
 *
 * 返回 resolved（parse 时求值一次，供既有消费点）+ raw/source（供请求期
 * 惰性重解析：env 引用轮换后下一次请求即生效，无需重启）。
 */
function resolveProviderApiKeyRef(
  providerId: string,
  value: unknown,
  env?: CredentialEnv,
  catalogEnvVar?: string,
): ApiKeyResolution {
  if (providerId === "ollama" && value === undefined) {
    return { resolved: "ollama", raw: "ollama", source: "literal" };
  }
  const hasBlankString = typeof value === "string" && value.trim().length === 0;
  const hasConfigValue = value !== undefined && value !== null && !hasBlankString;
  const rawValue = hasConfigValue ? value : catalogEnvVar ? `\${${catalogEnvVar}}` : value;
  const raw = typeof rawValue === "string" ? rawValue.trim() : undefined;
  return {
    resolved: resolveApiKey(rawValue, env),
    raw,
    source: isEnvReference(raw) ? "env" : "literal",
  };
}

/**
 * Ollama 模型列表自动识别：从探测缓存读取用户已安装的模型并转成模型定义。
 * 探测动作由配置加载层（loadPilotConfig）触发，本函数保持无副作用。
 * 探测到的 contextLength 作为 maxContextTokens 默认值，比协议通用默认
 * （128k）更贴合本地模型实际能力。
 */
function resolveOllamaModelsFromCache(rawUrl: string): Record<string, unknown> {
  const cached = getCachedOllamaModels(rawUrl);
  if (!cached || cached.length === 0) return {};
  return Object.fromEntries(
    cached.map(model => [
      model.id,
      model.contextLength && model.contextLength > 0 ? { capabilities: { maxContextTokens: model.contextLength } } : {},
    ]),
  );
}

function parseRetryConfig(raw: unknown): ProviderRetryConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return undefined;
  const result: ProviderRetryConfig = {};
  const numFields = [
    "requestMaxRetries",
    "streamMaxRetries",
    "streamIdleTimeoutMs",
    "maxStreamingDurationMs",
    "repeatedChunkLimit",
    "baseDelayMs",
    "maxDelayMs",
    "jitter",
  ] as const;
  for (const key of numFields) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ModelConfigError("invalid_config_value", `retry.${key} must be a non-negative number.`);
      }
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseModelDefinition(
  modelId: string,
  protocol: ModelProtocol,
  rawModel: unknown,
  providerId: string,
): ModelDefinition {
  const effectiveRaw = rawModel ?? {};
  if (!isRecord(effectiveRaw)) {
    throw new ModelConfigError("invalid_model", `Model ${modelId} must be an object.`);
  }

  const model = effectiveRaw as RawModelDefinition;
  const catalogHit = lookupCatalogModel(providerId, modelId);
  const catalogModel = catalogHit.model;

  const capabilities = parseCapabilities(protocol, model.capabilities, catalogModel?.capabilities);
  const multimodal = parseMultimodal(protocol, model.multimodal, catalogModel?.multimodal);

  return {
    id: modelId,
    displayName: typeof model.displayName === "string" ? model.displayName : catalogModel?.displayName,
    capabilities,
    multimodal,
    aliases: readStringArray(model.aliases, "aliases"),
  };
}

function parseCapabilities(
  protocol: ModelProtocol,
  rawCapabilities: unknown,
  catalogCapabilities?: ModelCapabilities,
): ModelCapabilities {
  const protocolDefaults =
    protocol === "anthropic"
      ? ANTHROPIC_DEFAULT_CAPABILITIES
      : protocol === "google"
        ? GOOGLE_DEFAULT_CAPABILITIES
        : OPENAI_DEFAULT_CAPABILITIES;
  const defaults = catalogCapabilities ?? protocolDefaults;

  if (rawCapabilities === undefined) {
    return defaults;
  }

  if (!isRecord(rawCapabilities)) {
    throw new ModelConfigError("invalid_capabilities", "Model capabilities must be an object.");
  }

  const capabilities = rawCapabilities as RawCapabilities;
  const overrides: Partial<ModelCapabilities> = {};

  for (const key of [
    "supportsToolUse",
    "supportsStreaming",
    "supportsParallelToolCalls",
    "supportsThinking",
    "supportsJsonSchema",
    "supportsSystemPrompt",
    "supportsPromptCache",
  ] as const) {
    if (capabilities[key] !== undefined) {
      if (typeof capabilities[key] !== "boolean") {
        throw new ModelConfigError("invalid_capabilities", `Capability ${key} must be boolean.`);
      }
      overrides[key] = capabilities[key];
    }
  }

  // Accept `contextWindow` as an alias for `maxContextTokens` so that
  // YAML configs using the friendlier name are not silently ignored.
  const raw = rawCapabilities as Record<string, unknown>;
  if (raw.contextWindow !== undefined && capabilities.maxContextTokens === undefined) {
    overrides.maxContextTokens = readPositiveNumber(raw.contextWindow, "contextWindow");
  }

  for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
    if (capabilities[key] !== undefined) {
      overrides[key] = readPositiveNumber(capabilities[key], key);
    }
  }

  return {
    ...mergeCapabilities(defaults, overrides),
    ...(capabilities.supportsThinking !== undefined ? { supportsThinkingExplicit: capabilities.supportsThinking } : {}),
  } as ModelCapabilities;
}

function parseMultimodal(
  protocol: ModelProtocol,
  rawMultimodal: unknown,
  catalogMultimodal?: MultimodalConstraints,
): MultimodalConstraints {
  const protocolDefaults =
    protocol === "anthropic"
      ? ANTHROPIC_DEFAULT_MULTIMODAL
      : protocol === "google"
        ? GOOGLE_DEFAULT_MULTIMODAL
        : OPENAI_DEFAULT_MULTIMODAL;
  const defaults = catalogMultimodal ?? { ...DEFAULT_MULTIMODAL_CONSTRAINTS, ...protocolDefaults };

  if (rawMultimodal === undefined) {
    return defaults;
  }

  if (!isRecord(rawMultimodal)) {
    throw new ModelConfigError("invalid_multimodal", "Model multimodal config must be an object.");
  }

  const multimodal = rawMultimodal as RawMultimodal;
  if (!Array.isArray(multimodal.input)) {
    throw new ModelConfigError("invalid_multimodal_input", "multimodal.input must be a string list.");
  }

  const input = multimodal.input.map(value => {
    if (!isInputModality(value)) {
      throw new ModelConfigError("invalid_multimodal_input", "multimodal.input contains unsupported modality.", {
        modality: value,
      });
    }
    return value;
  });

  return {
    ...defaults,
    input,
    maxImagesPerRequest: readOptionalPositiveNumber(multimodal.maxImagesPerRequest, "maxImagesPerRequest"),
    maxImageBytes: readOptionalPositiveNumber(multimodal.maxImageBytes, "maxImageBytes"),
    supportedImageMimeTypes: readStringArray(multimodal.supportedImageMimeTypes, "supportedImageMimeTypes"),
    maxPdfPages: readOptionalPositiveNumber(multimodal.maxPdfPages, "maxPdfPages"),
    maxPdfBytes: readOptionalPositiveNumber(multimodal.maxPdfBytes, "maxPdfBytes"),
    maxAudioSeconds: readOptionalPositiveNumber(multimodal.maxAudioSeconds, "maxAudioSeconds"),
    imageDetail: parseImageDetail(multimodal.imageDetail),
  };
}

function readPositiveNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a positive number.`);
  }
  return value;
}

function readOptionalPositiveNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readPositiveNumber(value, key);
}

function readStringRecord(value: unknown, key: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ModelConfigError("invalid_config_value", `${key} must be an object.`);
  }

  const output: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(value)) {
    if (typeof recordValue !== "string") {
      throw new ModelConfigError("invalid_config_value", `${key}.${recordKey} must be a string.`);
    }
    output[recordKey] = recordValue;
  }
  return output;
}

function readStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a string list.`);
  }

  return value;
}

function parseImageDetail(value: unknown): MultimodalConstraints["imageDetail"] {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto" || value === "low" || value === "high") {
    return value;
  }

  throw new ModelConfigError("invalid_multimodal", "multimodal.imageDetail must be auto, low or high.");
}

function assertValidUrl(value: string, providerId: string): void {
  try {
    new URL(value);
  } catch {
    throw new ModelConfigError("invalid_url", `Provider ${providerId} url is invalid.`, {
      providerId,
      url: value,
    });
  }
}
