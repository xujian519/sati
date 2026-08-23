import type { ApiModelListItem } from "../../../../shared/modelListApi";
import type { CatalogProviderProtocol } from "../../../../shared/catalogProviders";

export type LlmProviderConfigInput = {
  providerId: string;
  modelId: string;
  protocol: CatalogProviderProtocol;
  url: string;
  apiKey: string;
  apiModels: ReadonlyArray<ApiModelListItem> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the canonical config object for the onboarding LLM step without any
 * `as` casts. Nested sections are created on demand, the provider/model
 * entries are merged (preserving any existing per-model options), and legacy
 * top-level keys are dropped before the object is stringified to YAML.
 */
export function buildLlmConfig(existingConfig: unknown, input: LlmProviderConfigInput): Record<string, unknown> {
  const out = isRecord(existingConfig) ? { ...existingConfig } : {};

  if (!out.schemaVersion) out.schemaVersion = 1;

  const model = isRecord(out.model) ? out.model : {};
  out.model = model;

  const providers = isRecord(model.providers) ? model.providers : {};
  model.providers = providers;

  const rawProvider = providers[input.providerId];
  const existingProvider = isRecord(rawProvider) ? rawProvider : {};
  providers[input.providerId] = existingProvider;

  const existingModels = isRecord(existingProvider.models) ? existingProvider.models : {};
  existingProvider.models = existingModels;

  // 模型列表来自 provider 实际可用的模型：探测到完整列表时整体写入
  // 配置（运行时可自由切换），同时保留手动输入的模型 id。
  const detectedModels: Record<string, Record<string, unknown>> = {};
  if (input.apiModels && input.apiModels.length > 0) {
    for (const item of input.apiModels) {
      const rawModel = existingModels[item.id];
      detectedModels[item.id] = isRecord(rawModel) ? rawModel : {};
    }
  }

  existingProvider.protocol = input.protocol;
  existingProvider.url = input.url;
  existingProvider.apiKey = input.apiKey;
  existingProvider.timeoutMs = typeof existingProvider.timeoutMs === "number" ? existingProvider.timeoutMs : 120000;
  const rawModelId = existingModels[input.modelId];
  existingProvider.models = {
    ...existingModels,
    ...detectedModels,
    [input.modelId]: isRecord(rawModelId) ? rawModelId : {},
  };

  const agent = isRecord(out.agent) ? out.agent : {};
  out.agent = agent;
  agent.model = `${input.providerId}/${input.modelId}`;

  delete out.models;
  delete out.agents;
  delete out.version;

  return out;
}
