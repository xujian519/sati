import { isRecord } from "../../model/config/schema.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import { PilotConfigError, type PilotConfigDiagnostic, type PilotMemoryApiType, type PilotMemoryConfig } from "./types.js";

export function parseMemoryConfig(
  rawMemory: unknown,
  diagnostics: PilotConfigDiagnostic[],
  defaultRootDir: string,
  modelConfig?: ModelConfig,
): PilotMemoryConfig | undefined {
  if (rawMemory === undefined) {
    return undefined;
  }

  if (!isRecord(rawMemory)) {
    diagnostics.push({
      code: "CONFIG_MEMORY_INVALID",
      severity: "fatal",
      message: "memory config must be an object.",
      path: "memory",
      recoverable: false,
    });
    return undefined;
  }

  const enabled = readBoolean(rawMemory.enabled, true, "memory.enabled");
  const provider = readString(rawMemory.provider, "edgeclaw", "memory.provider");
  if (provider !== "edgeclaw") {
    diagnostics.push({
      code: "CONFIG_MEMORY_PROVIDER_UNSUPPORTED",
      severity: "fatal",
      message: `Unsupported memory provider ${provider}.`,
      path: "memory.provider",
      recoverable: false,
    });
    return undefined;
  }

  const memoryModel = parseMemoryModelRef(rawMemory.model, diagnostics, modelConfig);

  return {
    enabled,
    provider,
    rootDir: readOptionalString(rawMemory.rootDir, "memory.rootDir") ?? defaultRootDir,
    captureStrategy: readCaptureStrategy(rawMemory.captureStrategy),
    includeAssistant: readBoolean(rawMemory.includeAssistant, true, "memory.includeAssistant"),
    maxMessageChars: readOptionalPositiveNumber(rawMemory.maxMessageChars, "memory.maxMessageChars"),
    model: memoryModel,
    apiType: readMemoryApiType(rawMemory.apiType),
  };
}

function parseMemoryModelRef(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
  modelConfig?: ModelConfig,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new PilotConfigError(
      "CONFIG_MEMORY_MODEL_INVALID",
      'memory.model must be a "provider/model" string.',
    );
  }
  const sep = value.indexOf("/");
  if (sep < 0) {
    throw new PilotConfigError(
      "CONFIG_MEMORY_MODEL_INVALID",
      'memory.model must use "provider/model" format.',
    );
  }
  if (modelConfig) {
    const providerId = value.slice(0, sep);
    const modelId = value.slice(sep + 1);
    if (!modelConfig.providers[providerId]) {
      diagnostics.push({
        code: "CONFIG_MEMORY_MODEL_PROVIDER_NOT_FOUND",
        severity: "warning",
        message: `memory.model references unknown provider ${providerId}.`,
        path: "memory.model",
        recoverable: true,
      });
    } else if (!modelConfig.providers[providerId].models[modelId]) {
      diagnostics.push({
        code: "CONFIG_MEMORY_MODEL_NOT_FOUND",
        severity: "warning",
        message: `memory.model references unknown model ${modelId} for provider ${providerId}.`,
        path: "memory.model",
        recoverable: true,
      });
    }
  }
  return value;
}

function readMemoryApiType(value: unknown): PilotMemoryApiType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "openai-responses" || value === "responses" || value === "openai-completions") {
    return value;
  }
  throw new PilotConfigError(
    "CONFIG_MEMORY_VALUE_INVALID",
    "memory.apiType must be openai-responses, responses, or openai-completions.",
  );
}

function readCaptureStrategy(value: unknown): PilotMemoryConfig["captureStrategy"] {
  if (value === undefined) {
    return "last_turn";
  }
  if (value === "last_turn" || value === "full_session") {
    return value;
  }
  throw new PilotConfigError("CONFIG_MEMORY_CAPTURE_INVALID", "memory.captureStrategy must be last_turn or full_session.");
}

function readString(value: unknown, fallback: string, path: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", `${path} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, "", path);
}

function readBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", `${path} must be a boolean.`);
  }
  return value;
}

function readOptionalPositiveNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", `${path} must be a positive number.`);
  }
  return value;
}
