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
          model: "openai-main/gpt-5.1",
          apiType: "openai-completions",
          heartbeatBatchSize: 7,
          schedule: {
            reasoningMode: "accuracy_first",
            autoIndexIntervalMinutes: 1,
            autoDreamIntervalMinutes: 5,
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
      model: "openai-main/gpt-5.1",
      apiType: "openai-completions",
      heartbeatBatchSize: 7,
      schedule: {
        reasoningMode: "accuracy_first",
        autoIndexIntervalMinutes: 1,
        autoDreamIntervalMinutes: 5,
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

test("memory config warns on unknown top-level and schedule fields", () => {
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
          extraField: "ignored",
          schedule: {
            autoIndexIntervalMinutes: 1,
            typoField: true,
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

    assert.deepEqual(
      snapshot.diagnostics
        .filter((diagnostic) => diagnostic.code === "CONFIG_MEMORY_UNKNOWN_FIELD")
        .map((diagnostic) => ({ code: diagnostic.code, path: diagnostic.path })),
      [
        { code: "CONFIG_MEMORY_UNKNOWN_FIELD", path: "memory.schedule.typoField" },
        { code: "CONFIG_MEMORY_UNKNOWN_FIELD", path: "memory.extraField" },
      ],
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("memory config rejects invalid schedule reasoning mode", () => {
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
          schedule: {
            reasoningMode: "fast_first",
          },
        },
      }),
      "utf8",
    );

    assert.throws(
      () => loadPilotConfig({
        env: {
          PILOT_HOME: pilotHome,
          ANTHROPIC_API_KEY: "anthropic-key",
        },
      }),
      /memory\.schedule\.reasoningMode must be answer_first or accuracy_first\./,
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
