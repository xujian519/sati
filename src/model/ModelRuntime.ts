import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelConfig,
} from "./protocol/canonical.js";
import type { ModelCapabilities } from "./protocol/capabilities.js";
import { ModelRequestError } from "./protocol/errors.js";
import { complete, streamModel, type ModelRuntimeOptions } from "./streaming/streamModel.js";

export interface ModelRuntime {
  stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent>;
  complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse>;
  getCapabilities(providerId: string, modelId: string): ModelCapabilities;
}

export function createModelRuntime(
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): ModelRuntime {
  const getModel = (providerId: string, modelId: string) => {
    const provider = config.providers[providerId];
    if (!provider) {
      throw new ModelRequestError("provider_not_found", `Provider ${providerId} does not exist.`);
    }

    const model = provider.models[modelId];
    if (!model) {
      throw new ModelRequestError(
        "model_not_found",
        `Model ${modelId} does not exist in provider ${providerId}.`,
      );
    }

    return model;
  };

  return {
    stream: (request) => streamModel(request, config, options),
    complete: (request) => complete(request, config, options),
    getCapabilities: (providerId, modelId) => getModel(providerId, modelId).capabilities,
  };
}
