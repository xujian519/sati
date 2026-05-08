import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolitConfig } from "../../../src/polit/index.js";
import { getPolitConfigFilePath } from "../../../src/polit/paths.js";
import { validAgentConfig, validModelConfig } from "../../model/helpers.js";

test("loads EdgeClaw memory config from PolitDeck config", () => {
  const politHome = mkdtempSync(join(tmpdir(), "politdeck-memory-config-"));
  try {
    writeFileSync(
      getPolitConfigFilePath(politHome),
      JSON.stringify({
        schemaVersion: 1,
        agent: validAgentConfig(),
        model: validModelConfig(),
        memory: {
          provider: "edgeclaw",
          enabled: true,
          rootDir: "~/.politdeck/memory",
          captureStrategy: "full_session",
          includeAssistant: false,
          maxMessageChars: 12000,
          llm: {
            provider: "edgeclaw",
            model: "anthropic/claude-sonnet-4.6",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "secret-key",
            apiType: "openai-completions",
          },
        },
      }),
      "utf8",
    );

    const snapshot = loadPolitConfig({
      env: {
        POLIT_HOME: politHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.deepEqual(snapshot.config.memory, {
      provider: "edgeclaw",
      enabled: true,
      rootDir: "~/.politdeck/memory",
      captureStrategy: "full_session",
      includeAssistant: false,
      maxMessageChars: 12000,
      llm: {
        provider: "edgeclaw",
        model: "anthropic/claude-sonnet-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "secret-key",
        apiType: "openai-completions",
      },
    });
  } finally {
    rmSync(politHome, { recursive: true, force: true });
  }
});
