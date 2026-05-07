export { createModelRuntime, type ModelRuntime } from "./ModelRuntime.js";
export { parseModelConfig, type ParseModelConfigOptions } from "./config/parseModelConfig.js";
export { resolveApiKey, type CredentialEnv } from "./config/resolveCredentials.js";
export { ModelProviderRegistry, type ModelProviderAdapter } from "./providers/registry.js";
export { buildModelRequest, type ProviderRequestBody } from "./request/buildModelRequest.js";
export { validateModelRequest, type ResolvedModelRequest } from "./request/validateModelRequest.js";
export { parseModelResponse } from "./response/parseModelResponse.js";
export { complete, streamModel, type ModelRuntimeOptions, type ModelTransport } from "./streaming/streamModel.js";
export {
  normalizeStreamEvent,
  createStreamNormalizerState,
  type StreamNormalizerState,
} from "./streaming/normalizeStreamEvent.js";
export {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  type AssembledAssistantMessage,
  type ModelMessageAssemblerState,
} from "./streaming/assembleModelMessage.js";
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
export type { ModelCapabilities } from "./protocol/capabilities.js";
export type { InputModality, MultimodalConstraints } from "./protocol/multimodal.js";
export {
  ModelConfigError,
  ModelProviderError,
  ModelRequestError,
  type CanonicalModelError,
} from "./protocol/errors.js";
