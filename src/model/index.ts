export { createModelRuntime, type ModelRuntime } from "./ModelRuntime.js";
export { parseModelConfig, type ParseModelConfigOptions } from "./config/parseModelConfig.js";
export { resolveApiKey, type CredentialEnv } from "./config/resolveCredentials.js";
export type { ModelRuntimeOptions, ModelTransport } from "./streaming/streamModel.js";

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
