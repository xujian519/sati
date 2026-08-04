import { findCatalogProviderById } from "../../../../../shared/catalogProviders";
import { buildModelOptionsFromConfig } from "../../../../../shared/modelOptions";
import { patch } from "../../modelPool/utils/patch";
import type { SatiConfig } from "../../modelPool/types";
import type { ActiveModelCapabilities } from "../types";

export function splitModelRef(ref: string | undefined): { providerId: string; modelId: string } | null {
  const value = ref?.trim() ?? "";
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function ensureModelRefConfigured<T extends SatiConfig>(config: T, ref: string | undefined): T {
  const parsed = splitModelRef(ref);
  if (!parsed) return config;

  const provider = config.model?.providers?.[parsed.providerId];
  if (!provider) return config;
  if (provider.models && Object.prototype.hasOwnProperty.call(provider.models, parsed.modelId)) {
    return config;
  }

  return patch(config, ["model", "providers", parsed.providerId, "models", parsed.modelId], {});
}

export function ensureModelRefsConfigured<T extends SatiConfig>(config: T, refs: Array<string | undefined>): T {
  return refs.reduce((next, ref) => ensureModelRefConfigured(next, ref), config);
}

export function buildModelRefOptions(config: SatiConfig): Array<{ value: string; label: string }> {
  return buildModelOptionsFromConfig(config);
}

export function activeModelCapabilities(config: SatiConfig): ActiveModelCapabilities | null {
  const ref = config.agent?.model ?? "";
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const provider = config.model?.providers?.[providerId];
  if (!provider) return null;
  const userDef = provider.models?.[modelId];
  const userMultimodal =
    userDef && typeof userDef === "object" ? (userDef as Record<string, unknown>).multimodal : null;
  let multimodalInput: string[] | null = null;
  if (userMultimodal && typeof userMultimodal === "object") {
    const input = (userMultimodal as Record<string, unknown>).input;
    if (Array.isArray(input)) {
      multimodalInput = input.filter((s): s is string => typeof s === "string");
    }
  }
  const userCapabilities =
    userDef && typeof userDef === "object" ? (userDef as Record<string, unknown>).capabilities : null;
  let maxOutputTokensOverride: number | undefined;
  if (userCapabilities && typeof userCapabilities === "object") {
    const v = (userCapabilities as Record<string, unknown>).maxOutputTokens;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      maxOutputTokensOverride = v;
    }
  }
  const catalogProvider = findCatalogProviderById(providerId);
  const catalogModel = catalogProvider?.models.find(m => m.id === modelId);
  return {
    ref,
    providerId,
    modelId,
    catalogModel,
    catalogProvider,
    multimodalInput,
    maxOutputTokensOverride,
  };
}
