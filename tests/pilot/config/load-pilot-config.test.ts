import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createPilotConfigStore,
  loadPilotConfig,
  PilotConfigError,
} from "../../../src/pilot/config/index.js";
import {
  getPilotConfigFilePath,
  getPilotProjectChatDir,
  getPilotProjectConfigFilePath,
} from "../../../src/pilot/paths.js";
import { validAgentConfig, validModelConfig } from "../../model/helpers.js";

test("loads default config from PilotHome and resolves model env credentials", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });

    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.config.agent.model.provider, "anthropic-main");
    assert.equal(snapshot.config.agent.model.model, "claude-sonnet-4-5");
    assert.equal(snapshot.config.model.providers["anthropic-main"].apiKey, "anthropic-key");
    assert.deepEqual(
      snapshot.sources.map((source) => `${source.kind}:${source.phase ?? "file"}`),
      ["env:bootstrap", "default:file"],
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("ignores project config and applies env overrides on top of global config", () => {
  const pilotHome = makeTempDir();
  const projectRoot = makeTempDir();
  try {
    const modelConfig = validModelConfig() as { providers: Record<string, Record<string, unknown>> };
    const anthropicProvider = modelConfig.providers["anthropic-main"];
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: {
        providers: {
          ...modelConfig.providers,
          "anthropic-main": {
            ...anthropicProvider,
            timeoutMs: 2000,
          },
        },
      },
    });
    const projectConfigPath = getPilotProjectConfigFilePath(projectRoot);
    writeJson(projectConfigPath, {
      model: {
        providers: {
          "anthropic-main": {
            timeoutMs: 1000,
          },
        },
      },
    });

    const snapshot = loadPilotConfig({
      projectRoot,
      env: {
        PILOT_HOME: pilotHome,
        PILOT_AGENT_MODEL: "openai-main/gpt-5.1",
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.equal(snapshot.config.agent.model.provider, "openai-main");
    assert.equal(snapshot.config.agent.model.model, "gpt-5.1");
    assert.equal(snapshot.config.model.providers["anthropic-main"].timeoutMs, 2000);
    assert.ok(!snapshot.sources.some((source) => source.path === projectConfigPath));
    assert.deepEqual(snapshot.sources.map((source) => source.kind), [
      "env",
      "default",
      "env",
    ]);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ignores invalid project config YAML entirely", () => {
  const pilotHome = makeTempDir();
  const projectRoot = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });
    const projectConfigPath = getPilotProjectConfigFilePath(projectRoot);
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(projectConfigPath, "agent:\n  model: [", "utf8");

    const snapshot = loadPilotConfig({
      projectRoot,
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.equal(snapshot.config.agent.model.provider, "anthropic-main");
    assert.equal(snapshot.config.agent.model.model, "claude-sonnet-4-5");
    assert.ok(snapshot.diagnostics.every((diagnostic) => diagnostic.code !== "CONFIG_YAML_INVALID"));
    assert.ok(snapshot.sources.every((source) => source.path !== projectConfigPath));
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects pilot path configuration in YAML", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      pilot: {
        home: "/tmp/other",
      },
      model: validModelConfig(),
    });

    assert.throws(
      () =>
        loadPilotConfig({
          env: {
            PILOT_HOME: pilotHome,
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      (error) =>
        error instanceof PilotConfigError && error.code === "CONFIG_PILOT_SECTION_FORBIDDEN",
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("rejects an agent model that does not use provider/model format", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: {
        model: "claude-sonnet-4-5",
      },
      model: validModelConfig(),
    });

    assert.throws(
      () =>
        loadPilotConfig({
          env: {
            PILOT_HOME: pilotHome,
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      (error) =>
        error instanceof PilotConfigError && error.code === "CONFIG_AGENT_MODEL_INVALID",
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("rejects an agent model outside configured providers", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: {
        model: "anthropic-main/missing-model",
      },
      model: validModelConfig(),
    });

    assert.throws(
      () =>
        loadPilotConfig({
          env: {
            PILOT_HOME: pilotHome,
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      (error) =>
        error instanceof PilotConfigError && error.code === "CONFIG_AGENT_MODEL_NOT_FOUND",
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("loads optional agent subagent timeout config", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: {
        ...validAgentConfig(),
        subagents: {
          timeoutMs: 15000,
        },
      },
      model: validModelConfig(),
    });

    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.equal(snapshot.config.agent.subagents?.timeoutMs, 15000);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("derives project chat directory under PilotHome", () => {
  const pilotHome = "/tmp/pilot-home";
  const first = getPilotProjectChatDir("/repo/project", pilotHome);
  const second = getPilotProjectChatDir("/repo/project", pilotHome);
  const other = getPilotProjectChatDir("/repo/other", pilotHome);

  assert.equal(first, second);
  assert.equal(first, "/tmp/pilot-home/projects/repo-project/chats");
  assert.notEqual(first, other);
});

test("reload failure keeps the previous snapshot", async () => {
  const pilotHome = makeTempDir();
  try {
    const configPath = getPilotConfigFilePath(pilotHome);
    writeJson(configPath, {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });

    const store = await createPilotConfigStore({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });
    const previous = store.getSnapshot();

    writeJson(configPath, {
      schemaVersion: 1,
      agent: {
        model: "missing/claude-sonnet-4-5",
      },
      model: {
        providers: {},
      },
    });

    await assert.rejects(() => store.reload("test"), PilotConfigError);
    assert.equal(store.getSnapshot(), previous);
    assert.ok(store.getDiagnostics().some((diagnostic) => diagnostic.severity === "fatal"));
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("accepts a webui top-level section without emitting an unknown-field warning", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
      webui: {
        runtime: { serverPort: 3001 },
        memory: { autoIndexIntervalMinutes: 30 },
      },
    });

    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    const unknownFieldWarnings = snapshot.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "CONFIG_UNKNOWN_FIELD" && diagnostic.path === "webui",
    );
    assert.equal(unknownFieldWarnings.length, 0);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("warns on unknown top-level keys other than webui", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
      bogus: { ignored: true },
    });

    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    const bogusWarnings = snapshot.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "CONFIG_UNKNOWN_FIELD" && diagnostic.path === "bogus",
    );
    assert.equal(bogusWarnings.length, 1);
    assert.equal(bogusWarnings[0].severity, "warning");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pilotdeck-"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
