import {
  ANTHROPIC_DEFAULT_CAPABILITIES,
  ANTHROPIC_DEFAULT_MULTIMODAL,
} from "../providers/anthropic/defaults.js";
import {
  OPENAI_DEFAULT_CAPABILITIES,
  OPENAI_DEFAULT_MULTIMODAL,
} from "../providers/openai/defaults.js";
import type {
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";
import { mergeCapabilities, type ModelCapabilities } from "../protocol/capabilities.js";
import { ModelConfigError } from "../protocol/errors.js";
import {
  DEFAULT_MULTIMODAL_CONSTRAINTS,
  isInputModality,
  type MultimodalConstraints,
} from "../protocol/multimodal.js";
import { resolveApiKey, type CredentialEnv } from "./resolveCredentials.js";
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
    providers[providerId] = parseProvider(providerId, rawProvider, options.env);
  }

  return {
    providers,
  };
}

function parseProvider(providerId: string, rawProvider: unknown, env?: CredentialEnv): ProviderConfig {
  if (!isRecord(rawProvider)) {
    throw new ModelConfigError("invalid_provider", `Provider ${providerId} must be an object.`);
  }

  const provider = rawProvider as RawProviderConfig;
  if (!isModelProtocol(provider.protocol)) {
    throw new ModelConfigError("unsupported_protocol", `Provider ${providerId} has unsupported protocol.`, {
      providerId,
      protocol: provider.protocol,
    });
  }

  const url = readRequiredString(provider.url, "url");
  assertValidUrl(url, providerId);

  if (!isRecord(provider.models) || Object.keys(provider.models).length === 0) {
    throw new ModelConfigError("empty_models", `Provider ${providerId} must contain at least one model.`, {
      providerId,
    });
  }

  const protocol = provider.protocol;
  const models: Record<string, ModelDefinition> = {};
  for (const [modelId, rawModel] of Object.entries(provider.models)) {
    models[modelId] = parseModelDefinition(modelId, protocol, rawModel);
  }

  return {
    id: providerId,
    protocol,
    url,
    apiKey: resolveApiKey(provider.apiKey, env),
    timeoutMs: readOptionalPositiveNumber(provider.timeoutMs, "timeoutMs"),
    headers: readStringRecord(provider.headers, "headers"),
    retry: isRecord(provider.retry) ? provider.retry : undefined,
    models,
  };
}

function parseModelDefinition(
  modelId: string,
  protocol: ModelProtocol,
  rawModel: unknown,
): ModelDefinition {
  if (!isRecord(rawModel)) {
    throw new ModelConfigError("invalid_model", `Model ${modelId} must be an object.`);
  }

  const model = rawModel as RawModelDefinition;
  const capabilities = parseCapabilities(protocol, model.capabilities);
  const multimodal = parseMultimodal(protocol, model.multimodal);

  return {
    id: modelId,
    displayName: typeof model.displayName === "string" ? model.displayName : undefined,
    capabilities,
    multimodal,
    aliases: readStringArray(model.aliases, "aliases"),
  };
}

function parseCapabilities(protocol: ModelProtocol, rawCapabilities: unknown): ModelCapabilities {
  const defaults =
    protocol === "anthropic" ? ANTHROPIC_DEFAULT_CAPABILITIES : OPENAI_DEFAULT_CAPABILITIES;

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

  return mergeCapabilities(defaults, overrides);
}

function parseMultimodal(protocol: ModelProtocol, rawMultimodal: unknown): MultimodalConstraints {
  const defaults =
    protocol === "anthropic" ? ANTHROPIC_DEFAULT_MULTIMODAL : OPENAI_DEFAULT_MULTIMODAL;

  if (rawMultimodal === undefined) {
    return { ...DEFAULT_MULTIMODAL_CONSTRAINTS, ...defaults };
  }

  if (!isRecord(rawMultimodal)) {
    throw new ModelConfigError("invalid_multimodal", "Model multimodal config must be an object.");
  }

  const multimodal = rawMultimodal as RawMultimodal;
  if (!Array.isArray(multimodal.input)) {
    throw new ModelConfigError("invalid_multimodal_input", "multimodal.input must be a string list.");
  }

  const input = multimodal.input.map((value) => {
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
    maxImagesPerRequest: readOptionalPositiveNumber(
      multimodal.maxImagesPerRequest,
      "maxImagesPerRequest",
    ),
    maxImageBytes: readOptionalPositiveNumber(multimodal.maxImageBytes, "maxImageBytes"),
    supportedImageMimeTypes: readStringArray(
      multimodal.supportedImageMimeTypes,
      "supportedImageMimeTypes",
    ),
    maxPdfPages: readOptionalPositiveNumber(multimodal.maxPdfPages, "maxPdfPages"),
    maxPdfBytes: readOptionalPositiveNumber(multimodal.maxPdfBytes, "maxPdfBytes"),
    maxAudioSeconds: readOptionalPositiveNumber(multimodal.maxAudioSeconds, "maxAudioSeconds"),
    imageDetail: parseImageDetail(multimodal.imageDetail),
  };
}

function readRequiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a non-empty string.`);
  }
  return value;
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

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
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
