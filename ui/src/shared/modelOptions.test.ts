import { describe, expect, it } from "vitest";
import { buildModelOptionsFromConfig } from "./modelOptions";

describe("buildModelOptionsFromConfig", () => {
  it("returns catalog-enriched labels for known providers", () => {
    const options = buildModelOptionsFromConfig({
      model: {
        providers: {
          deepseek: {
            protocol: "openai",
            url: "https://api.deepseek.com/v1",
            models: { "deepseek-v4-pro": {}, "deepseek-v4-flash": {} },
          },
        },
      },
    });

    expect(options).toContainEqual({ value: "deepseek/deepseek-v4-pro", label: "DeepSeek: DeepSeek V4 Pro" });
    expect(options).toContainEqual({ value: "deepseek/deepseek-v4-flash", label: "DeepSeek: DeepSeek V4 Flash" });
  });

  it("falls back to the raw ref label for unknown providers", () => {
    const options = buildModelOptionsFromConfig({
      model: {
        providers: {
          custom: {
            protocol: "openai",
            url: "https://example.com/v1",
            models: { "my-model-1": {}, "my-model-2": {} },
          },
        },
      },
    });

    expect(options).toContainEqual({ value: "custom/my-model-1", label: "custom/my-model-1" });
    expect(options).toContainEqual({ value: "custom/my-model-2", label: "custom/my-model-2" });
  });

  it("merges catalog models with user-declared models without duplicates", () => {
    const options = buildModelOptionsFromConfig({
      model: {
        providers: {
          deepseek: {
            protocol: "openai",
            url: "https://api.deepseek.com/v1",
            // deepseek-chat exists in the catalog; custom-model does not.
            models: { "deepseek-chat": {}, "custom-model": {} },
          },
        },
      },
    });

    const values = options.map(option => option.value);
    expect(values.filter(value => value === "deepseek/deepseek-chat")).toHaveLength(1);
    expect(values).toContain("deepseek/custom-model");
  });

  it("returns an empty list for an unconfigured (fresh install) config", () => {
    expect(buildModelOptionsFromConfig({ model: { providers: {} } })).toEqual([]);
    expect(buildModelOptionsFromConfig(null)).toEqual([]);
    expect(buildModelOptionsFromConfig(undefined)).toEqual([]);
    expect(buildModelOptionsFromConfig({})).toEqual([]);
  });

  it("skips array-shaped provider.models instead of emitting index garbage", () => {
    // YAML 列表（数组）无法推导模型 ref；Object.keys 会给索引——必须跳过。
    // 未知 provider：无 catalog 可回退，列表形状的 models 产生空选项。
    const unknown = buildModelOptionsFromConfig({
      model: {
        providers: {
          custom: {
            protocol: "openai",
            url: "https://example.com/v1",
            models: ["my-model-1", "my-model-2"],
          },
        },
      },
    });
    expect(unknown).toEqual([]);

    // 已知 provider：catalog 模型仍发射，但绝不出现 "openai/0" 式索引垃圾。
    const known = buildModelOptionsFromConfig({
      model: {
        providers: {
          openai: {
            protocol: "openai",
            url: "https://api.openai.com/v1",
            models: ["gpt-4o", "qwen3"],
          },
        },
      },
    });
    const values = known.map(option => option.value);
    expect(values.some(value => /\/\d+$/.test(value))).toBe(false);
    expect(values).toContain("openai/gpt-4o");
  });
});
