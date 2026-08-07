import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { ModelConfigError } from "../../../src/model/protocol/errors.js";

test("catalog provider resolves api key from default env var when apiKey is omitted", () => {
  const config = parseModelConfig(
    {
      providers: {
        openai: {
          models: { "gpt-4o-mini": {} },
        },
      },
    },
    { env: { OPENAI_API_KEY: " sk-env " } },
  );

  assert.equal(config.providers.openai.apiKey, "sk-env");
});

test("catalog provider resolves api key from default env var when apiKey is blank", () => {
  const config = parseModelConfig(
    {
      providers: {
        google: {
          apiKey: "  ",
          models: { "gemini-2.0-flash": {} },
        },
      },
    },
    { env: { GEMINI_API_KEY: " gemini-env " } },
  );

  assert.equal(config.providers.google.apiKey, "gemini-env");
});

test("skips a pure stub provider (no url, no apiKey, no models) instead of failing", () => {
  const config = parseModelConfig({
    providers: {
      provider1: {
        protocol: "openai",
        url: "",
        apiKey: "",
        models: {},
      },
      deepseek: {
        protocol: "openai",
        url: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        models: { "deepseek-v4-flash": {} },
      },
    },
  });

  assert.equal("provider1" in config.providers, false);
  assert.equal(config.providers.deepseek.url, "https://api.deepseek.com/v1");
});

test("still fails when a url-less provider declares models (real misconfig, not a stub)", () => {
  assert.throws(
    () =>
      parseModelConfig({
        providers: {
          provider1: {
            protocol: "openai",
            url: "",
            apiKey: "sk-test",
            models: { "some-model": {} },
          },
        },
      }),
    (error: unknown) => error instanceof ModelConfigError && error.message.includes("requires a url"),
  );
});
