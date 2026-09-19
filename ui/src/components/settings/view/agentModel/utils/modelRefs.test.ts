import { describe, expect, it } from "vitest";
import { findCatalogProviderById, type CatalogProviderProtocol } from "../../../../../shared/catalogProviders";
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

    // 目录数值本身由 check:catalog-mirror 对拍引擎；这里只验证「命中目录 → 取目录值」这一层。
    const entry = findCatalogProviderById("zhipu")?.models.find(model => model.id === "glm-4.6");
    expect(entry).toBeDefined();
    expect(caps?.protocol).toBe("openai");
    expect(caps?.effectiveContext).toEqual({ tokens: entry?.maxContextTokens, source: "catalog" });
    expect(caps?.effectiveOutput).toEqual({ tokens: entry?.maxOutputTokens, source: "catalog" });
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

describe("窗口覆盖层（observed / probe）", () => {
  it("无覆盖层时，未命中目录的模型仍按协议默认", () => {
    const caps = activeModelCapabilities(relayConfig("openai"));
    expect(caps?.effectiveContext).toEqual({ tokens: 128000, source: "default" });
    expect(caps?.windowOverride).toBeUndefined();
  });

  it("probe 值覆盖协议默认，来源标注 probe，并保留条目供采纳", () => {
    const caps = activeModelCapabilities(relayConfig("openai"), {
      "relay/custom-model": {
        maxContextTokens: 262144,
        maxOutputTokens: 64000,
        source: "probe",
        via: "context_length",
      },
    });
    expect(caps?.effectiveContext).toEqual({ tokens: 262144, source: "probe" });
    expect(caps?.effectiveOutput).toEqual({ tokens: 64000, source: "probe" });
    expect(caps?.windowOverride?.via).toBe("context_length");
  });

  it("observed（实测）同样参与解析并标注 observed", () => {
    const caps = activeModelCapabilities(relayConfig("openai"), {
      "relay/custom-model": { maxContextTokens: 131072, source: "observed", via: "provider-context-cap" },
    });
    expect(caps?.effectiveContext).toEqual({ tokens: 131072, source: "observed" });
  });

  it("覆盖层高于目录条目（引擎同序：config > 覆盖层 > catalog > 默认）", () => {
    const withCatalog = activeModelCapabilities({
      agent: { model: "zhipu/glm-4.6" },
      model: { providers: { zhipu: { url: "https://api.z.ai/api/paas/v4", apiKey: "k" } } },
    });
    expect(withCatalog?.effectiveContext.source).toBe("catalog");

    const withOverlay = activeModelCapabilities(
      {
        agent: { model: "zhipu/glm-4.6" },
        model: { providers: { zhipu: { url: "https://api.z.ai/api/paas/v4", apiKey: "k" } } },
      },
      { "zhipu/glm-4.6": { maxContextTokens: 4096, source: "observed" } },
    );
    expect(withOverlay?.effectiveContext).toEqual({ tokens: 4096, source: "observed" });
  });

  it("模型显式声明优先于覆盖层", () => {
    const caps = activeModelCapabilities(relayConfig("openai", { capabilities: { maxContextTokens: 96000 } }), {
      "relay/custom-model": { maxContextTokens: 262144, source: "probe" },
    });
    expect(caps?.effectiveContext).toEqual({ tokens: 96000, source: "config" });
  });

  it("覆盖层只给输出上限时，上下文档不受影响", () => {
    const caps = activeModelCapabilities(relayConfig("openai"), {
      "relay/custom-model": { maxOutputTokens: 4096, source: "probe" },
    });
    expect(caps?.effectiveOutput).toEqual({ tokens: 4096, source: "probe" });
    expect(caps?.effectiveContext).toEqual({ tokens: 128000, source: "default" });
  });

  it("其他 provider/model 的条目不影响当前模型", () => {
    const caps = activeModelCapabilities(relayConfig("openai"), {
      "other/model": { maxContextTokens: 262144, source: "probe" },
    });
    expect(caps?.effectiveContext).toEqual({ tokens: 128000, source: "default" });
  });
});
