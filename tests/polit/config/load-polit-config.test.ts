import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPolitConfigStore,
  loadPolitConfig,
  PolitConfigError,
} from "../../../src/polit/config/index.js";
import { getPolitConfigFilePath, getPolitProjectChatDir } from "../../../src/polit/paths.js";
import { validAgentConfig, validModelConfig } from "../../model/helpers.js";

test("loads default config from PolitHome and resolves model env credentials", () => {
  const politHome = makeTempDir();
  try {
    writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });

    const snapshot = loadPolitConfig({
      env: {
        POLIT_HOME: politHome,
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
    rmSync(politHome, { recursive: true, force: true });
  }
});

test("merges default, project and env sources by priority", () => {
  const politHome = makeTempDir();
  const projectRoot = makeTempDir();
  try {
    writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });
    writeJson(join(projectRoot, ".politdeck.yaml"), {
      model: {
        providers: {
          "anthropic-main": {
            timeoutMs: 1000,
          },
        },
      },
    });

    const snapshot = loadPolitConfig({
      projectRoot,
      env: {
        POLIT_HOME: politHome,
        POLIT_AGENT_MODEL: "openai-main/gpt-5.1",
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    assert.equal(snapshot.config.agent.model.provider, "openai-main");
    assert.equal(snapshot.config.agent.model.model, "gpt-5.1");
    assert.equal(snapshot.config.model.providers["anthropic-main"].timeoutMs, 1000);
    assert.deepEqual(snapshot.sources.map((source) => source.kind), [
      "env",
      "default",
      "project",
      "env",
    ]);
  } finally {
    rmSync(politHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects polit path configuration in YAML", () => {
  const politHome = makeTempDir();
  try {
    writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      polit: {
        home: "/tmp/other",
      },
      model: validModelConfig(),
    });

    assert.throws(
      () =>
        loadPolitConfig({
          env: {
            POLIT_HOME: politHome,
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      (error) =>
        error instanceof PolitConfigError && error.code === "CONFIG_POLIT_SECTION_FORBIDDEN",
    );
  } finally {
    rmSync(politHome, { recursive: true, force: true });
  }
});

test("rejects an agent model that does not use provider/model format", () => {
  const politHome = makeTempDir();
  try {
    writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: {
        model: "claude-sonnet-4-5",
      },
      model: validModelConfig(),
    });

    assert.throws(
      () =>
        loadPolitConfig({
          env: {
            POLIT_HOME: politHome,
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      (error) =>
        error instanceof PolitConfigError && error.code === "CONFIG_AGENT_MODEL_INVALID",
    );
  } finally {
    rmSync(politHome, { recursive: true, force: true });
  }
});

test("rejects an agent model outside configured providers", () => {
  const politHome = makeTempDir();
  try {
    writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: {
        model: "anthropic-main/missing-model",
      },
      model: validModelConfig(),
    });

    assert.throws(
      () =>
        loadPolitConfig({
          env: {
            POLIT_HOME: politHome,
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      (error) =>
        error instanceof PolitConfigError && error.code === "CONFIG_AGENT_MODEL_NOT_FOUND",
    );
  } finally {
    rmSync(politHome, { recursive: true, force: true });
  }
});

test("derives project chat directory under PolitHome", () => {
  const politHome = "/tmp/polit-home";
  const first = getPolitProjectChatDir("/repo/project", politHome);
  const second = getPolitProjectChatDir("/repo/project", politHome);
  const other = getPolitProjectChatDir("/repo/other", politHome);

  assert.equal(first, second);
  assert.equal(first, "/tmp/polit-home/projects/repo-project/chats");
  assert.notEqual(first, other);
});

test("reload failure keeps the previous snapshot", async () => {
  const politHome = makeTempDir();
  try {
    const configPath = getPolitConfigFilePath(politHome);
    writeJson(configPath, {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });

    const store = await createPolitConfigStore({
      env: {
        POLIT_HOME: politHome,
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

    await assert.rejects(() => store.reload("test"), PolitConfigError);
    assert.equal(store.getSnapshot(), previous);
    assert.ok(store.getDiagnostics().some((diagnostic) => diagnostic.severity === "fatal"));
  } finally {
    rmSync(politHome, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "politdeck-"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
