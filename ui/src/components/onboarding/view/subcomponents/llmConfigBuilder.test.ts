import { describe, expect, it } from "vitest";
import { buildLlmConfig } from "./llmConfigBuilder";

const DEEPSEEK_INPUT = {
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  protocol: "openai" as const,
  url: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  apiModels: null,
};

describe("buildLlmConfig", () => {
  it("creates a fresh config when none exists", () => {
    const config = buildLlmConfig(undefined, DEEPSEEK_INPUT);
    expect(config.schemaVersion).toBe(1);
    expect(config.model).toEqual({
      providers: {
        deepseek: {
          protocol: "openai",
          url: "https://api.deepseek.com/v1",
          apiKey: "sk-test",
          timeoutMs: 120000,
          models: { "deepseek-v4-flash": {} },
        },
      },
    });
    expect(config.agent).toEqual({ model: "deepseek/deepseek-v4-flash" });
  });

  it("treats a non-object existing config as fresh", () => {
    const config = buildLlmConfig("garbage", DEEPSEEK_INPUT);
    expect(config.schemaVersion).toBe(1);
    expect(config.agent).toEqual({ model: "deepseek/deepseek-v4-flash" });
  });

  it("merges detected models while preserving existing per-model options", () => {
    const existing = {
      schemaVersion: 1,
      model: {
        providers: {
          deepseek: {
            protocol: "openai",
            url: "https://api.deepseek.com/v1",
            apiKey: "sk-old",
            timeoutMs: 5000,
            models: { "deepseek-v4-flash": { temperature: 0.2 } },
          },
          openai: { protocol: "openai", url: "https://api.openai.com/v1", apiKey: "sk-openai", models: {} },
        },
      },
      agent: { model: "deepseek/deepseek-v4-flash" },
      models: "legacy",
      agents: "legacy",
      version: "0.1",
    };
    const config = buildLlmConfig(existing, {
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
      protocol: "openai",
      url: "https://api.deepseek.com/v1",
      apiKey: "sk-new",
      apiModels: [{ id: "deepseek-v4-flash", displayName: "V4 Flash" }],
    });

    expect(config.model).toEqual({
      providers: {
        deepseek: {
          protocol: "openai",
          url: "https://api.deepseek.com/v1",
          apiKey: "sk-new",
          timeoutMs: 5000,
          models: {
            "deepseek-v4-flash": { temperature: 0.2 },
            "deepseek-reasoner": {},
          },
        },
        openai: { protocol: "openai", url: "https://api.openai.com/v1", apiKey: "sk-openai", models: {} },
      },
    });
    expect(config.agent).toEqual({ model: "deepseek/deepseek-reasoner" });
    expect(config.models).toBeUndefined();
    expect(config.agents).toBeUndefined();
    expect(config.version).toBeUndefined();
  });

  it("defaults timeoutMs when the existing value is not a number", () => {
    const existing = {
      model: { providers: { deepseek: { timeoutMs: "5s" } } },
    };
    const config = buildLlmConfig(existing, DEEPSEEK_INPUT);
    const { providers } = config.model as { providers: Record<string, { timeoutMs?: unknown }> };
    expect(providers.deepseek.timeoutMs).toBe(120000);
  });
});
