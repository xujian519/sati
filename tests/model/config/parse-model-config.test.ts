import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { ModelConfigError } from "../../../src/model/protocol/errors.js";
import { validModelConfig } from "../helpers.js";

test("parses provider, model capabilities and multimodal constraints", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });

  const provider = config.providers["anthropic-main"];
  const model = provider.models["claude-sonnet-4-5"];

  assert.equal(provider.protocol, "anthropic");
  assert.equal(provider.apiKey, "anthropic-key");
  assert.equal(model.capabilities.supportsThinking, true);
  assert.equal(model.capabilities.supportsSystemPrompt, true);
  assert.deepEqual(model.multimodal.input, ["text", "image", "pdf"]);
  assert.equal(model.multimodal.maxImagesPerRequest, 20);
});

test("rejects unsupported multimodal input", () => {
  const raw = validModelConfig();
  const anthropic = raw.providers as Record<string, any>;
  anthropic["anthropic-main"].models["claude-sonnet-4-5"].multimodal.input = ["text", "video"];

  assert.throws(
    () => parseModelConfig(raw, { env: { ANTHROPIC_API_KEY: "anthropic-key" } }),
    (error) => error instanceof ModelConfigError && error.code === "invalid_multimodal_input",
  );
});

test("rejects model config without providers", () => {
  assert.throws(
    () => parseModelConfig({}, { env: { ANTHROPIC_API_KEY: "anthropic-key" } }),
    (error) => error instanceof ModelConfigError && error.code === "missing_provider",
  );
});

test("trims whitespace from provider url and apiKey", () => {
  const raw = validModelConfig();
  const providers = raw.providers as Record<string, any>;
  providers["openai-main"].url = "  https://api.openai.com/v1\n";
  providers["openai-main"].apiKey = " sk-from-yaml ";

  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });

  assert.equal(config.providers["openai-main"].url, "https://api.openai.com/v1");
  assert.equal(config.providers["openai-main"].apiKey, "sk-from-yaml");
});

test("defaults unknown local OpenAI-compatible models to image input", () => {
  const config = parseModelConfig({
    providers: {
      local: {
        protocol: "openai",
        url: "http://localhost:52010/v1",
        apiKey: "local-key",
        models: {
          "qwen3.6-35b-a3b": {
            capabilities: {
              maxOutputTokens: 16384,
            },
          },
        },
      },
    },
  });

  const model = config.providers.local.models["qwen3.6-35b-a3b"];
  assert.deepEqual(model.multimodal.input, ["text", "image"]);
  assert.equal(model.multimodal.maxImagesPerRequest, 20);
  assert.deepEqual(model.multimodal.supportedImageMimeTypes, [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
});
