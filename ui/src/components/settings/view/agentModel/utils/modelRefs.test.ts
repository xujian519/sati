import { describe, expect, it } from "vitest";
import type { CatalogProviderProtocol } from "../../../../../shared/catalogProviders";
import type { SatiConfig } from "../../modelPool/types";
import { activeModelCapabilities } from "./modelRefs";

/** Relay provider: not in the UI catalog, so every limit comes from a lower layer. */
function relayConfig(
  protocol: CatalogProviderProtocol | undefined,
  modelDef: Record<string, unknown> = {},
): SatiConfig {
  return {
    agent: { model: "relay/custom-model" },
    model: {
      providers: {
        relay: {
          ...(protocol ? { protocol } : {}),
          url: "https://relay.test/v1",
          apiKey: "k",
          models: { "custom-model": modelDef },
        },
      },
    },
  };
}

describe("activeModelCapabilities effective limits", () => {
  it("uses the catalog entry when the model is catalogued", () => {
    const caps = activeModelCapabilities({
      agent: { model: "zhipu/glm-4.6" },
      model: { providers: { zhipu: { url: "https://api.z.ai/api/paas/v4", apiKey: "k" } } },
    });

    expect(caps?.protocol).toBe("openai");
    expect(caps?.effectiveContext).toEqual({ tokens: 131_072, source: "catalog" });
    expect(caps?.effectiveOutput).toEqual({ tokens: 131_072, source: "catalog" });
  });

  it("falls back to the declared protocol default when the model is not catalogued", () => {
    const caps = activeModelCapabilities(relayConfig("anthropic"));

    expect(caps?.effectiveContext).toEqual({ tokens: 200_000, source: "default" });
    expect(caps?.effectiveOutput).toEqual({ tokens: 32_768, source: "default" });
  });

  it("assumes openai when neither the provider nor the catalog declares a protocol", () => {
    const caps = activeModelCapabilities(relayConfig(undefined));

    expect(caps?.protocol).toBe("openai");
    expect(caps?.effectiveContext).toEqual({ tokens: 128_000, source: "default" });
  });

  it("prefers the model declaration over catalog and protocol defaults", () => {
    const caps = activeModelCapabilities(
      relayConfig("google", { capabilities: { maxContextTokens: 64_000, maxOutputTokens: 4_096 } }),
    );

    expect(caps?.effectiveContext).toEqual({ tokens: 64_000, source: "config" });
    expect(caps?.effectiveOutput).toEqual({ tokens: 4_096, source: "config" });
  });

  it("ignores non-positive and non-numeric declared limits", () => {
    const caps = activeModelCapabilities(
      relayConfig("anthropic", { capabilities: { maxContextTokens: 0, maxOutputTokens: "4096" } }),
    );

    expect(caps?.effectiveContext).toEqual({ tokens: 200_000, source: "default" });
    expect(caps?.effectiveOutput).toEqual({ tokens: 32_768, source: "default" });
  });

  it("returns null when the agent model ref is missing or malformed", () => {
    expect(activeModelCapabilities({})).toBeNull();
    expect(activeModelCapabilities({ agent: { model: "no-slash" } })).toBeNull();
    expect(activeModelCapabilities({ agent: { model: "relay/" } })).toBeNull();
    expect(activeModelCapabilities({ agent: { model: "relay/x" } })).toBeNull();
  });
});
