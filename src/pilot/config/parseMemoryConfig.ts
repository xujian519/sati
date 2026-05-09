import { isRecord } from "../../model/config/schema.js";
import { PilotConfigError, type PilotConfigDiagnostic, type PilotMemoryConfig, type PilotMemoryLlmConfig } from "./types.js";

export function parseMemoryConfig(
  rawMemory: unknown,
  diagnostics: PilotConfigDiagnostic[],
  defaultRootDir: string,
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

  return {
    enabled,
    provider,
    rootDir: readOptionalString(rawMemory.rootDir, "memory.rootDir") ?? defaultRootDir,
    captureStrategy: readCaptureStrategy(rawMemory.captureStrategy),
    includeAssistant: readBoolean(rawMemory.includeAssistant, true, "memory.includeAssistant"),
    maxMessageChars: readOptionalPositiveNumber(rawMemory.maxMessageChars, "memory.maxMessageChars"),
    llm: parseMemoryLlm(rawMemory.llm),
  };
}

function parseMemoryLlm(value: unknown): PilotMemoryLlmConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_MEMORY_LLM_INVALID", "memory.llm must be an object.");
  }
  return {
    provider: readOptionalString(value.provider, "memory.llm.provider"),
    model: readOptionalString(value.model, "memory.llm.model"),
    baseUrl: readOptionalString(value.baseUrl, "memory.llm.baseUrl"),
    apiKey: readOptionalString(value.apiKey, "memory.llm.apiKey"),
    apiType: readMemoryApiType(value.apiType),
  };
}

function readMemoryApiType(value: unknown): PilotMemoryLlmConfig["apiType"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "openai-responses" || value === "responses" || value === "openai-completions") {
    return value;
  }
  throw new PilotConfigError(
    "CONFIG_MEMORY_VALUE_INVALID",
    "memory.llm.apiType must be openai-responses, responses, or openai-completions.",
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
