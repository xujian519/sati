import { describe, expect, it } from "vitest";
import type { CatalogProvider } from "../../../../shared/catalogProviders";
import {
  hasUsableApiKey,
  modelUsesRemoteDefault,
  requiresApiKey,
  resolveLoadErrorKind,
  resolveNextModels,
  type ModelLoadContext,
} from "./llmModelLoading";

function makeCtx(overrides: Partial<ModelLoadContext> = {}): ModelLoadContext {
  return {
    providerId: "deepseek",
    protocol: "openai",
    url: "https://api.deepseek.com/v1",
    apiKey: "",
    isCustomMode: false,
    requiresApiKey: true,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "openai",
    defaultUrl: "https://api.deepseek.com/v1",
    models: [{ id: "deepseek-v4-flash", displayName: "V4 Flash" }],
    ...overrides,
  };
}

const A = { id: "a", displayName: "A model" };
const B = { id: "b", displayName: "B model" };

describe("hasUsableApiKey", () => {
  it("rejects blank, placeholder and masked values", () => {
    expect(hasUsableApiKey("")).toBe(false);
    expect(hasUsableApiKey("   ")).toBe(false);
    expect(hasUsableApiKey("PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE")).toBe(false);
    expect(hasUsableApiKey("********")).toBe(false);
  });
  it("accepts a real key", () => {
    expect(hasUsableApiKey("sk-abc")).toBe(true);
  });
});

describe("requiresApiKey", () => {
  it("defaults to true unless the provider opts out", () => {
    expect(requiresApiKey(makeProvider())).toBe(true);
    expect(requiresApiKey(makeProvider({ requiresApiKey: false }))).toBe(false);
    expect(requiresApiKey(null)).toBe(true);
  });
});

describe("modelUsesRemoteDefault", () => {
  it("uses remote default on auto-load when the catalog provider needs a key and none is set", () => {
    expect(modelUsesRemoteDefault("auto", makeCtx())).toBe(true);
  });
  it("uses the direct endpoint when a key is present, mode is custom, or no key is required", () => {
    expect(modelUsesRemoteDefault("auto", makeCtx({ apiKey: "sk-abc" }))).toBe(false);
    expect(modelUsesRemoteDefault("auto", makeCtx({ isCustomMode: true }))).toBe(false);
    expect(modelUsesRemoteDefault("auto", makeCtx({ requiresApiKey: false }))).toBe(false);
  });
  it("manual fetch uses remote default whenever no usable key is attached (even mid typing)", () => {
    expect(modelUsesRemoteDefault("manual", makeCtx())).toBe(true);
    expect(modelUsesRemoteDefault("manual", makeCtx({ apiKey: "sk-abc" }))).toBe(false);
    expect(modelUsesRemoteDefault("manual", makeCtx({ isCustomMode: true }))).toBe(false);
  });
});

describe("resolveNextModels", () => {
  it("auto remote-default falls back to the bundled catalog when the list is empty", () => {
    expect(resolveNextModels("auto", makeCtx(), makeProvider(), [])).toEqual([
      { id: "deepseek-v4-flash", displayName: "V4 Flash" },
    ]);
  });
  it("auto remote-default keeps a non-empty list", () => {
    expect(resolveNextModels("auto", makeCtx(), makeProvider(), [A, B])).toEqual([A, B]);
  });
  it("auto provider path with no key falls back to the catalog only when the list is empty", () => {
    const provider = makeProvider();
    expect(resolveNextModels("auto", makeCtx({ requiresApiKey: false }), provider, [])).toEqual(provider.models);
    expect(resolveNextModels("auto", makeCtx({ requiresApiKey: false }), provider, [A])).toEqual([A]);
  });
  it("manual fetch falls back to the catalog when keyless, otherwise keeps the resolved list", () => {
    expect(resolveNextModels("manual", makeCtx(), makeProvider(), [])).toEqual(makeProvider().models);
    expect(resolveNextModels("manual", makeCtx({ apiKey: "sk-abc" }), makeProvider(), [A])).toEqual([A]);
  });
});

describe("resolveLoadErrorKind", () => {
  it("auto remote-default reports the remote fallback", () => {
    expect(resolveLoadErrorKind("auto", makeCtx(), makeProvider())).toBe("remote-default");
  });
  it("auto provider path on a keyless provider falls back to local", () => {
    expect(resolveLoadErrorKind("auto", makeCtx({ requiresApiKey: false }), makeProvider())).toBe("local-fallback");
  });
  it("other auto paths and manual fetches surface a hard error", () => {
    expect(resolveLoadErrorKind("auto", makeCtx({ apiKey: "sk-abc" }), makeProvider())).toBe("error");
    expect(resolveLoadErrorKind("manual", makeCtx(), makeProvider())).toBe("error");
  });
});
