import { isRecord } from "../../model/config/schema.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import {
  PilotConfigError,
  type PilotConfigDiagnostic,
  type PilotKnowledgeProfileConfig,
  type PilotMemoryApiType,
  type PilotMemoryConfig,
  type PilotMemoryEmbeddingConfig,
  type PilotMemoryReasoningMode,
  type PilotMemoryRerankConfig,
  type PilotMemoryScheduleConfig,
} from "./types.js";

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
  const schedule = parseMemorySchedule(rawMemory.schedule, diagnostics) ?? buildScheduleFromFlatFields(rawMemory);
  const embedding = parseMemoryEmbeddingConfig(rawMemory.embedding, diagnostics, modelConfig);
  const knowledgeProfile = parseKnowledgeProfile(rawMemory.knowledgeProfile, diagnostics);

  const KNOWN_FIELDS = new Set([
    "enabled",
    "provider",
    "rootDir",
    "captureStrategy",
    "includeAssistant",
    "maxMessageChars",
    "retrievalTimeoutMs",
    "model",
    "apiType",
    "schedule",
    "heartbeatBatchSize",
    "reasoningMode",
    "autoIndexIntervalMinutes",
    "autoDreamIntervalMinutes",
    "embedding",
    "knowledgeProfile",
  ]);
  for (const key of Object.keys(rawMemory)) {
    if (!KNOWN_FIELDS.has(key)) {
      diagnostics.push({
        code: "CONFIG_MEMORY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown memory field ${key}.`,
        path: `memory.${key}`,
        recoverable: true,
      });
    }
  }

  return {
    enabled,
    provider,
    rootDir: readOptionalString(rawMemory.rootDir, "memory.rootDir") ?? defaultRootDir,
    captureStrategy: readCaptureStrategy(rawMemory.captureStrategy),
    includeAssistant: readBoolean(rawMemory.includeAssistant, true, "memory.includeAssistant"),
    maxMessageChars: readOptionalPositiveNumber(rawMemory.maxMessageChars, "memory.maxMessageChars"),
    retrievalTimeoutMs: readOptionalPositiveInteger(rawMemory.retrievalTimeoutMs, "memory.retrievalTimeoutMs"),
    model: memoryModel,
    apiType: readMemoryApiType(rawMemory.apiType),
    schedule,
    heartbeatBatchSize: readOptionalPositiveInteger(rawMemory.heartbeatBatchSize, "memory.heartbeatBatchSize"),
    embedding,
    knowledgeProfile,
  };
}

/**
 * 解析项目知识偏好（memory.knowledgeProfile）：domains / ipcSections /
 * focusReasonTypes 三个字符串数组字段。缺省返回 undefined（行为与现状一致）。
 */
function parseKnowledgeProfile(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotKnowledgeProfileConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", "memory.knowledgeProfile must be an object.");
  }
  const readStringArray = (key: string): string[] | undefined => {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.some(item => typeof item !== "string" || item.trim().length === 0)) {
      throw new PilotConfigError(
        "CONFIG_MEMORY_VALUE_INVALID",
        `memory.knowledgeProfile.${key} must be an array of non-empty strings.`,
      );
    }
    return raw.map(item => item.trim());
  };
  const domains = readStringArray("domains");
  const ipcSections = readStringArray("ipcSections");
  const focusReasonTypes = readStringArray("focusReasonTypes");
  for (const key of Object.keys(value)) {
    if (key !== "domains" && key !== "ipcSections" && key !== "focusReasonTypes") {
      diagnostics.push({
        code: "CONFIG_MEMORY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown memory.knowledgeProfile field ${key}.`,
        path: `memory.knowledgeProfile.${key}`,
        recoverable: true,
      });
    }
  }
  if (!domains && !ipcSections && !focusReasonTypes) {
    return undefined;
  }
  return {
    ...(domains ? { domains } : {}),
    ...(ipcSections ? { ipcSections } : {}),
    ...(focusReasonTypes ? { focusReasonTypes } : {}),
  };
}

const MEMORY_EMBEDDING_KNOWN_FIELDS = new Set([
  "enabled",
  "provider",
  "model",
  "baseUrl",
  "apiKey",
  "dimensions",
  "timeoutMs",
  "batchSize",
  "indexMemory",
  "indexWiki",
  "rerank",
]);

const MEMORY_RERANK_KNOWN_FIELDS = new Set([
  "enabled",
  "provider",
  "model",
  "baseUrl",
  "apiKey",
  "timeoutMs",
  "topN",
  "style",
]);

function parseMemoryRerankConfig(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
  modelConfig?: ModelConfig,
): PilotMemoryRerankConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", "memory.embedding.rerank must be an object.");
  }

  const provider = readOptionalString(value.provider, "memory.embedding.rerank.provider");
  const baseUrl = readOptionalString(value.baseUrl, "memory.embedding.rerank.baseUrl");
  if (!provider && !baseUrl) {
    throw new PilotConfigError(
      "CONFIG_MEMORY_RERANK_INVALID",
      "memory.embedding.rerank requires either provider or baseUrl.",
    );
  }
  if (provider && modelConfig && !modelConfig.providers[provider]) {
    diagnostics.push({
      code: "CONFIG_MEMORY_RERANK_PROVIDER_NOT_FOUND",
      severity: "warning",
      message: `memory.embedding.rerank references unknown provider ${provider}.`,
      path: "memory.embedding.rerank.provider",
      recoverable: true,
    });
  }

  for (const key of Object.keys(value)) {
    if (!MEMORY_RERANK_KNOWN_FIELDS.has(key)) {
      diagnostics.push({
        code: "CONFIG_MEMORY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown memory.embedding.rerank field ${key}.`,
        path: `memory.embedding.rerank.${key}`,
        recoverable: true,
      });
    }
  }

  const rerank: PilotMemoryRerankConfig = {
    enabled: readBoolean(value.enabled, true, "memory.embedding.rerank.enabled"),
  };
  if (provider) rerank.provider = provider;
  if (baseUrl) rerank.baseUrl = baseUrl;
  const model = readOptionalString(value.model, "memory.embedding.rerank.model");
  if (model !== undefined) rerank.model = model;
  const apiKey = readOptionalString(value.apiKey, "memory.embedding.rerank.apiKey");
  if (apiKey !== undefined) rerank.apiKey = apiKey;
  const timeoutMs = readOptionalPositiveInteger(value.timeoutMs, "memory.embedding.rerank.timeoutMs");
  if (timeoutMs !== undefined) rerank.timeoutMs = timeoutMs;
  const topN = readOptionalPositiveInteger(value.topN, "memory.embedding.rerank.topN");
  if (topN !== undefined) rerank.topN = topN;
  const style = readOptionalRerankStyle(value.style);
  if (style !== undefined) rerank.style = style;

  return rerank;
}

/** 解析 rerank 请求风格：tei（默认）或 jina（oMLX 等）。 */
function readOptionalRerankStyle(value: unknown): "tei" | "jina" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "tei" || value === "jina") {
    return value;
  }
  throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", "memory.embedding.rerank.style must be 'tei' or 'jina'.");
}

function parseMemoryEmbeddingConfig(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
  modelConfig?: ModelConfig,
): PilotMemoryEmbeddingConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", "memory.embedding must be an object.");
  }

  const provider = readOptionalString(value.provider, "memory.embedding.provider");
  const baseUrl = readOptionalString(value.baseUrl, "memory.embedding.baseUrl");
  const model = readOptionalString(value.model, "memory.embedding.model");

  if (!provider && !baseUrl) {
    throw new PilotConfigError(
      "CONFIG_MEMORY_EMBEDDING_INVALID",
      "memory.embedding requires either provider or baseUrl.",
    );
  }
  if (!model) {
    throw new PilotConfigError("CONFIG_MEMORY_EMBEDDING_INVALID", "memory.embedding requires model.");
  }
  if (provider && modelConfig && !modelConfig.providers[provider]) {
    diagnostics.push({
      code: "CONFIG_MEMORY_EMBEDDING_PROVIDER_NOT_FOUND",
      severity: "warning",
      message: `memory.embedding references unknown provider ${provider}.`,
      path: "memory.embedding.provider",
      recoverable: true,
    });
  }

  for (const key of Object.keys(value)) {
    if (!MEMORY_EMBEDDING_KNOWN_FIELDS.has(key)) {
      diagnostics.push({
        code: "CONFIG_MEMORY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown memory.embedding field ${key}.`,
        path: `memory.embedding.${key}`,
        recoverable: true,
      });
    }
  }

  const embedding: PilotMemoryEmbeddingConfig = {
    enabled: readBoolean(value.enabled, true, "memory.embedding.enabled"),
    model,
    indexMemory: readBoolean(value.indexMemory, true, "memory.embedding.indexMemory"),
    indexWiki: readBoolean(value.indexWiki, true, "memory.embedding.indexWiki"),
  };
  if (provider) embedding.provider = provider;
  if (baseUrl) embedding.baseUrl = baseUrl;
  const apiKey = readOptionalString(value.apiKey, "memory.embedding.apiKey");
  if (apiKey !== undefined) embedding.apiKey = apiKey;
  const dimensions = readOptionalPositiveInteger(value.dimensions, "memory.embedding.dimensions");
  if (dimensions !== undefined) embedding.dimensions = dimensions;
  const timeoutMs = readOptionalPositiveInteger(value.timeoutMs, "memory.embedding.timeoutMs");
  if (timeoutMs !== undefined) embedding.timeoutMs = timeoutMs;
  const batchSize = readOptionalPositiveInteger(value.batchSize, "memory.embedding.batchSize");
  if (batchSize !== undefined) embedding.batchSize = batchSize;
  const rerank = parseMemoryRerankConfig(value.rerank, diagnostics, modelConfig);
  if (rerank !== undefined) embedding.rerank = rerank;

  return embedding;
}

function parseMemorySchedule(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotMemoryScheduleConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", "memory.schedule must be an object.");
  }
  const schedule: PilotMemoryScheduleConfig = {};
  const reasoningMode = readOptionalMemoryReasoningMode(value.reasoningMode);
  if (reasoningMode !== undefined) schedule.reasoningMode = reasoningMode;
  const autoIndexIntervalMinutes = readOptionalNonNegativeInteger(
    value.autoIndexIntervalMinutes,
    "memory.schedule.autoIndexIntervalMinutes",
  );
  if (autoIndexIntervalMinutes !== undefined) {
    schedule.autoIndexIntervalMinutes = autoIndexIntervalMinutes;
  }
  const autoDreamIntervalMinutes = readOptionalNonNegativeInteger(
    value.autoDreamIntervalMinutes,
    "memory.schedule.autoDreamIntervalMinutes",
  );
  if (autoDreamIntervalMinutes !== undefined) {
    schedule.autoDreamIntervalMinutes = autoDreamIntervalMinutes;
  }
  for (const key of Object.keys(value)) {
    if (key !== "reasoningMode" && key !== "autoIndexIntervalMinutes" && key !== "autoDreamIntervalMinutes") {
      diagnostics.push({
        code: "CONFIG_MEMORY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown memory.schedule field ${key}.`,
        path: `memory.schedule.${key}`,
        recoverable: true,
      });
    }
  }
  return Object.keys(schedule).length > 0 ? schedule : undefined;
}

function buildScheduleFromFlatFields(rawMemory: Record<string, unknown>): PilotMemoryScheduleConfig | undefined {
  const schedule: PilotMemoryScheduleConfig = {};
  const reasoningMode = readOptionalMemoryReasoningMode(rawMemory.reasoningMode);
  if (reasoningMode !== undefined) schedule.reasoningMode = reasoningMode;
  if (typeof rawMemory.autoIndexIntervalMinutes === "number" && rawMemory.autoIndexIntervalMinutes >= 0) {
    schedule.autoIndexIntervalMinutes = rawMemory.autoIndexIntervalMinutes;
  }
  if (typeof rawMemory.autoDreamIntervalMinutes === "number" && rawMemory.autoDreamIntervalMinutes >= 0) {
    schedule.autoDreamIntervalMinutes = rawMemory.autoDreamIntervalMinutes;
  }
  return Object.keys(schedule).length > 0 ? schedule : undefined;
}

function parseMemoryModelRef(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
  modelConfig?: ModelConfig,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PilotConfigError("CONFIG_MEMORY_MODEL_INVALID", 'memory.model must be a "provider/model" string.');
  }
  const sep = value.indexOf("/");
  if (sep < 0) {
    throw new PilotConfigError("CONFIG_MEMORY_MODEL_INVALID", 'memory.model must use "provider/model" format.');
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
  if (
    value === "openai-responses" ||
    value === "responses" ||
    value === "openai-completions" ||
    value === "anthropic" ||
    value === "google"
  ) {
    return value;
  }
  throw new PilotConfigError(
    "CONFIG_MEMORY_VALUE_INVALID",
    "memory.apiType must be openai-responses, responses, openai-completions, anthropic, or google.",
  );
}

function readOptionalMemoryReasoningMode(value: unknown): PilotMemoryReasoningMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "answer_first" || value === "accuracy_first") {
    return value;
  }
  throw new PilotConfigError(
    "CONFIG_MEMORY_VALUE_INVALID",
    "memory.schedule.reasoningMode must be answer_first or accuracy_first.",
  );
}

function readCaptureStrategy(value: unknown): PilotMemoryConfig["captureStrategy"] {
  if (value === undefined) {
    return "last_turn";
  }
  if (value === "last_turn" || value === "full_session") {
    return value;
  }
  throw new PilotConfigError(
    "CONFIG_MEMORY_CAPTURE_INVALID",
    "memory.captureStrategy must be last_turn or full_session.",
  );
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

function readOptionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", `${path} must be a positive number.`);
  }
  return Math.floor(value);
}

function readOptionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PilotConfigError("CONFIG_MEMORY_VALUE_INVALID", `${path} must be a non-negative number.`);
  }
  return Math.floor(value);
}
