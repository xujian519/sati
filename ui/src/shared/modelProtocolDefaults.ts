/**
 * UI-side mirror of the engine's per-protocol capability defaults:
 * `src/model/providers/{openai,anthropic,google}/defaults.ts`. `openai-responses`
 * reuses the openai defaults — `src/model/config/parseModelConfig.ts` picks the
 * anthropic / google constants by protocol and falls back to openai for the rest.
 *
 * The settings page needs these numbers because a model declared without
 * `capabilities` falls back to them, and the page has to show the window that
 * will actually take effect instead of a hard-coded guess. The engine is the
 * source of truth; `tests/model/protocol-defaults-parity.spec.ts` fails when the
 * two sides drift.
 */
import type { CatalogProviderProtocol } from "./catalogProviders";
import protocolDefaults from "./modelProtocolDefaults.json";

export type ProtocolModelDefaults = {
  maxContextTokens: number;
  maxOutputTokens: number;
};

export const PROTOCOL_MODEL_DEFAULTS: Record<CatalogProviderProtocol, ProtocolModelDefaults> = protocolDefaults;

/** Protocol assumed when neither the provider nor the catalog declares one. */
export const FALLBACK_PROTOCOL: CatalogProviderProtocol = "openai";
