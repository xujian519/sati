import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelConfig,
  ModelProtocol,
  ModelTokenLimitSources,
} from "./protocol/canonical.js";
import type { ModelCapabilities } from "./protocol/capabilities.js";
import { ModelRequestError } from "./protocol/errors.js";
import type { MultimodalConstraints } from "./protocol/multimodal.js";
import { normalizeProviderBaseUrl } from "./normalizeProviderBaseUrl.js";
import { complete, streamModel, type ModelRuntimeOptions } from "./streaming/streamModel.js";

export interface ModelRuntime {
  stream(request: CanonicalModelRequest, options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent>;
  complete(request: CanonicalModelRequest, options?: ModelRuntimeOptions): Promise<CanonicalModelResponse>;
  getCapabilities(providerId: string, modelId: string): ModelCapabilities;
  /**
   * Token 上限的来源层（可选：旧实现/测试替身可省略）。调用方只能把
   * `protocol-default` 当兜底假设——它不是模型真实容量。
   */
  getTokenLimitSources?(providerId: string, modelId: string): ModelTokenLimitSources | undefined;
  getMultimodal(providerId: string, modelId: string): MultimodalConstraints;
  getProviderProtocol(providerId: string): ModelProtocol | undefined;
  getProviderBaseUrl(providerId: string): string | undefined;
}

export function createModelRuntime(config: ModelConfig, options: ModelRuntimeOptions = {}): ModelRuntime {
  const getModel = (providerId: string, modelId: string) => {
    const provider = config.providers[providerId];
    if (!provider) {
      throw new ModelRequestError("provider_not_found", `Provider ${providerId} does not exist.`);
    }

    const model = provider.models[modelId];
    if (!model) {
      throw new ModelRequestError("model_not_found", `Model ${modelId} does not exist in provider ${providerId}.`);
    }

    return model;
  };

  return {
    stream: (request, callOptions) => streamModel(request, config, { ...options, ...callOptions }),
    complete: (request, callOptions) => complete(request, config, { ...options, ...callOptions }),
    getCapabilities: (providerId, modelId) => getModel(providerId, modelId).capabilities,
    getTokenLimitSources: (providerId, modelId) => getModel(providerId, modelId).tokenLimitSources,
    getMultimodal: (providerId, modelId) => getModel(providerId, modelId).multimodal,
    getProviderProtocol: providerId => config.providers[providerId]?.protocol,
    getProviderBaseUrl: providerId => {
      const url = config.providers[providerId]?.url;
      return url ? normalizeProviderBaseUrl(url) : undefined;
    },
  };
}
