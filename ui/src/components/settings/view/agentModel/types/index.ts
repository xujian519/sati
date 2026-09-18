import type { CatalogModel, CatalogProvider, CatalogProviderProtocol } from "../../../../../shared/catalogProviders";

/** Which layer supplied a resolved limit — mirrors the engine's `ModelInfoSource`. */
export type CapabilitySource = "config" | "catalog" | "default";

/** A limit together with the layer it came from, so the settings page can label it. */
export type ResolvedLimit = {
  tokens: number;
  source: CapabilitySource;
};

export type ActiveModelCapabilities = {
  ref: string;
  providerId: string;
  modelId: string;
  catalogModel?: CatalogModel;
  catalogProvider?: CatalogProvider;
  /** Declared protocol, else the catalog provider's, else openai. */
  protocol: CatalogProviderProtocol;
  multimodalInput: string[] | null;
  maxOutputTokensOverride: number | undefined;
  maxContextTokensOverride: number | undefined;
  /**
   * What the engine will use when `agent.maxContextTokens` is empty: the model
   * declaration, else the catalog entry, else the protocol default.
   */
  effectiveContext: ResolvedLimit;
  /** Same resolution for `capabilities.maxOutputTokens` (no agent-level field exists). */
  effectiveOutput: ResolvedLimit;
};
