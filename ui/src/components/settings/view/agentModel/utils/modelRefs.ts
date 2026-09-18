import { findCatalogProviderById } from "../../../../../shared/catalogProviders";
import {
  FALLBACK_PROTOCOL,
  PROTOCOL_MODEL_DEFAULTS,
  type ProtocolModelDefaults,
} from "../../../../../shared/modelProtocolDefaults";
import { patch } from "../../modelPool/utils/patch";
import type { SatiConfig } from "../../modelPool/types";
import type { ActiveModelCapabilities, ResolvedLimit } from "../types";

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

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function protocolDefaultsFor(protocol: string | undefined): ProtocolModelDefaults {
  const known = protocol as keyof typeof PROTOCOL_MODEL_DEFAULTS | undefined;
  return (known ? PROTOCOL_MODEL_DEFAULTS[known] : undefined) ?? PROTOCOL_MODEL_DEFAULTS[FALLBACK_PROTOCOL];
}

/** Model declaration > catalog entry > protocol default — the engine's own order. */
function resolveLimit(
  override: number | undefined,
  catalogValue: number | undefined,
  protocolValue: number,
): ResolvedLimit {
  if (override !== undefined) return { tokens: override, source: "config" };
  if (catalogValue !== undefined) return { tokens: catalogValue, source: "catalog" };
  return { tokens: protocolValue, source: "default" };
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
  const declared = userCapabilities && typeof userCapabilities === "object" ? userCapabilities : null;
  const maxOutputTokensOverride = positiveInt((declared as Record<string, unknown> | null)?.maxOutputTokens);
  const maxContextTokensOverride = positiveInt((declared as Record<string, unknown> | null)?.maxContextTokens);
  const catalogProvider = findCatalogProviderById(providerId);
  const catalogModel = catalogProvider?.models.find(m => m.id === modelId);
  const protocol = provider.protocol ?? catalogProvider?.protocol ?? FALLBACK_PROTOCOL;
  const protocolDefaults = protocolDefaultsFor(protocol);
  return {
    ref,
    providerId,
    modelId,
    catalogModel,
    catalogProvider,
    protocol,
    multimodalInput,
    maxOutputTokensOverride,
    maxContextTokensOverride,
    effectiveContext: resolveLimit(
      maxContextTokensOverride,
      catalogModel?.maxContextTokens,
      protocolDefaults.maxContextTokens,
    ),
    effectiveOutput: resolveLimit(
      maxOutputTokensOverride,
      catalogModel?.maxOutputTokens,
      protocolDefaults.maxOutputTokens,
    ),
  };
}
