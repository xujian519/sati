import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { lookupCatalogModel } from "../../../src/model/catalog/index.js";

test("empty model definition gets capabilities and multimodal from catalog", () => {
  const config = parseModelConfig({
    providers: {
      deepseek: {
        apiKey: "sk-test",
        models: {
          "deepseek-v4-pro": {},
        },
      },
    },
  });

  const model = config.providers["deepseek"].models["deepseek-v4-pro"];
  assert.equal(model.displayName, "DeepSeek V4 Pro");
  assert.equal(model.capabilities.supportsToolUse, true);
  assert.equal(model.capabilities.maxContextTokens, 131072);
  assert.deepEqual(model.multimodal.input, ["text"]);
});

test("catalog provider fills in protocol and url when omitted", () => {
  const config = parseModelConfig({
    providers: {
      deepseek: {
        apiKey: "sk-test",
        models: { "deepseek-chat": {} },
      },
    },
  });

  const provider = config.providers["deepseek"];
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.url, "https://api.deepseek.com/v1");
});

test("user YAML overrides catalog defaults", () => {
  const config = parseModelConfig({
    providers: {
      deepseek: {
        apiKey: "sk-test",
        models: {
          "deepseek-v4-pro": {
            capabilities: {
              maxOutputTokens: 16384,
            },
            multimodal: {
              input: ["text", "image"],
            },
          },
        },
      },
    },
  });

  const model = config.providers["deepseek"].models["deepseek-v4-pro"];
  assert.equal(model.capabilities.maxOutputTokens, 16384);
  assert.equal(model.capabilities.supportsToolUse, true);
  assert.deepEqual(model.multimodal.input, ["text", "image"]);
});

test("unknown model falls back to protocol defaults", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://custom.example.com/v1",
        apiKey: "sk-test",
        models: {
          "my-custom-model": {},
        },
      },
    },
  });

  const model = config.providers["custom"].models["my-custom-model"];
  assert.equal(model.capabilities.supportsToolUse, true);
  assert.equal(model.capabilities.maxContextTokens, 128000);
  assert.deepEqual(model.multimodal.input, ["text"]);
});

test("vendor-prefixed model lookup: anthropic/claude-sonnet-4.6 on openrouter", () => {
  const config = parseModelConfig({
    providers: {
      edgeclaw: {
        protocol: "openai",
        url: "https://openrouter.ai/api/v1",
        apiKey: "sk-test",
        models: {
          "anthropic/claude-sonnet-4.6": {},
        },
      },
    },
  });

  const model = config.providers["edgeclaw"].models["anthropic/claude-sonnet-4.6"];
  assert.equal(model.displayName, "Claude Sonnet 4.6");
  assert.equal(model.capabilities.supportsToolUse, true);
  assert.equal(model.capabilities.maxContextTokens, 200000);
  assert.ok(model.multimodal.input.includes("image"));
  assert.ok(model.multimodal.input.includes("pdf"));
});

test("null model definition (YAML bare key) gets catalog defaults", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        apiKey: "sk-test",
        models: {
          "gpt-4o": null,
        },
      },
    },
  });

  const model = config.providers["openai"].models["gpt-4o"];
  assert.equal(model.displayName, "GPT-4o");
  assert.equal(model.capabilities.supportsParallelToolCalls, true);
  assert.ok(model.multimodal.input.includes("image"));
});

test("lookupCatalogModel returns correct match types", () => {
  const exact = lookupCatalogModel("deepseek", "deepseek-v4-pro");
  assert.equal(exact.matchType, "exact");
  assert.ok(exact.model);

  const alias = lookupCatalogModel("anthropic", "claude-sonnet-4.5");
  assert.equal(alias.matchType, "alias");
  assert.ok(alias.model);

  const crossProvider = lookupCatalogModel("custom", "gemini-2.5-pro");
  assert.equal(crossProvider.matchType, "cross-provider");
  assert.ok(crossProvider.model);

  const none = lookupCatalogModel("custom", "unknown-model-xyz");
  assert.equal(none.matchType, "none");
  assert.equal(none.model, undefined);
});
