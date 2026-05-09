import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { getPilotConfigFilePath } from "../../../src/pilot/paths.js";
import { validAgentConfig, validModelConfig } from "../../model/helpers.js";

test("loads EdgeClaw memory config from PilotDeck config", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-memory-config-"));
  try {
    writeFileSync(
      getPilotConfigFilePath(pilotHome),
      JSON.stringify({
        schemaVersion: 1,
        agent: validAgentConfig(),
        model: validModelConfig(),
        memory: {
          provider: "edgeclaw",
          enabled: true,
          rootDir: "~/.pilotdeck/memory",
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

    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.deepEqual(snapshot.config.memory, {
      provider: "edgeclaw",
      enabled: true,
      rootDir: "~/.pilotdeck/memory",
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
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("defaults memory rootDir to PilotHome memory directory", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-memory-config-"));
  try {
    writeFileSync(
      getPilotConfigFilePath(pilotHome),
      JSON.stringify({
        schemaVersion: 1,
        agent: validAgentConfig(),
        model: validModelConfig(),
        memory: {
          provider: "edgeclaw",
          enabled: true,
        },
      }),
      "utf8",
    );

    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.equal(snapshot.config.memory?.rootDir, join(pilotHome, "memory"));
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
