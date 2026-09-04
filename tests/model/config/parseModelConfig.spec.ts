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

test("custom url without explicit apiKey no longer auto-adopts the catalog env var", () => {
  assert.throws(
    () =>
      parseModelConfig(
        {
          providers: {
            anthropic: {
              url: "https://my-proxy.example.com",
              models: { "claude-sonnet-4-5-20250929": {} },
            },
          },
        },
        { env: { ANTHROPIC_API_KEY: "sk-leak" } },
      ),
    (error: unknown) =>
      error instanceof ModelConfigError &&
      error.code === "missing_credential" &&
      error.message.includes("ANTHROPIC_API_KEY"),
  );
});

test("custom url with an explicit literal apiKey still parses", () => {
  const config = parseModelConfig(
    {
      providers: {
        anthropic: {
          url: "https://my-proxy.example.com",
          apiKey: "sk-explicit",
          models: { "claude-sonnet-4-5-20250929": {} },
        },
      },
    },
    { env: {} },
  );

  assert.equal(config.providers.anthropic.apiKey, "sk-explicit");
});

test("custom url with an explicit ${VAR} apiKey still parses", () => {
  const config = parseModelConfig(
    {
      providers: {
        anthropic: {
          url: "https://my-proxy.example.com",
          apiKey: "${MY_PROXY_KEY}",
          models: { "claude-sonnet-4-5-20250929": {} },
        },
      },
    },
    { env: { MY_PROXY_KEY: "sk-proxy" } },
  );

  assert.equal(config.providers.anthropic.apiKey, "sk-proxy");
  assert.equal(config.providers.anthropic.apiKeySource, "env");
});

test("catalog env var still applies when the custom url equals the catalog endpoint", () => {
  const config = parseModelConfig(
    {
      providers: {
        openai: {
          url: "https://api.openai.com/v1/",
          models: { "gpt-4o-mini": {} },
        },
      },
    },
    { env: { OPENAI_API_KEY: "sk-env" } },
  );

  assert.equal(config.providers.openai.apiKey, "sk-env");
});
