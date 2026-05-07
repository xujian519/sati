import { complete, streamModel } from "./streaming/streamModel.js";
import { createModelRuntime } from "./runtime.js";

export { parseModelConfig, type ParseModelConfigOptions } from "./config/parseModelConfig.js";
export { resolveApiKey, type CredentialEnv } from "./config/resolveCredentials.js";
export { ModelProviderRegistry, type ModelProviderAdapter } from "./providers/registry.js";
export { buildModelRequest, type ProviderRequestBody } from "./request/buildModelRequest.js";
export { validateModelRequest, type ResolvedModelRequest } from "./request/validateModelRequest.js";
export { parseModelResponse } from "./response/parseModelResponse.js";
export { complete, streamModel, type ModelRuntimeOptions, type ModelTransport } from "./streaming/streamModel.js";
export { createModelRuntime, type ModelRuntime } from "./runtime.js";
export {
  normalizeStreamEvent,
  createStreamNormalizerState,
  type StreamNormalizerState,
} from "./streaming/normalizeStreamEvent.js";
export { normalizeModelError } from "./errors/normalizeModelError.js";

export type {
  CanonicalAudioBlock,
  CanonicalContentBlock,
  CanonicalFinishReason,
  CanonicalImageBlock,
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalPdfBlock,
  CanonicalRole,
  CanonicalTextBlock,
  CanonicalThinkingBlock,
  CanonicalThinkingConfig,
  CanonicalToolCall,
  CanonicalToolCallBlock,
  CanonicalToolChoice,
  CanonicalToolResultBlock,
  CanonicalToolResult,
  CanonicalToolSchema,
  CanonicalUsage,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "./protocol/canonical.js";
export {
  DEFAULT_MODEL_CAPABILITIES,
  mergeCapabilities,
  type ModelCapabilities,
} from "./protocol/capabilities.js";
export {
  DEFAULT_MULTIMODAL_CONSTRAINTS,
  SUPPORTED_INPUT_MODALITIES,
  assertContentSupported,
  contentBlockToInputModality,
  isInputModality,
  type InputModality,
  type MultimodalConstraints,
} from "./protocol/multimodal.js";
export {
  ModelConfigError,
  ModelProviderError,
  ModelRequestError,
  type CanonicalModelError,
} from "./protocol/errors.js";

export const Model = {
  complete,
  stream: streamModel,
  createRuntime: createModelRuntime,
};
