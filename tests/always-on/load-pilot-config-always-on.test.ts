import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadPilotConfig, PilotConfigError } from "../../src/pilot/config/index.js";
import { getPilotConfigFilePath } from "../../src/pilot/paths.js";
import { validAgentConfig, validModelConfig } from "../model/helpers.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pilotdeck-aon-config-"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

test("loadPilotConfig surfaces alwaysOn snapshot when section is present", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
      alwaysOn: {
        enabled: true,
        trigger: { enabled: true, dailyBudget: 2 },
        projects: { "/tmp/projects/sample": { enabled: true } },
      },
    });
    const snapshot = loadPilotConfig({
      env: { PILOT_HOME: pilotHome, ANTHROPIC_API_KEY: "key" },
    });
    assert.ok(snapshot.config.alwaysOn);
    assert.equal(snapshot.config.alwaysOn?.enabled, true);
    assert.equal(snapshot.config.alwaysOn?.trigger.dailyBudget, 2);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("loadPilotConfig fatally rejects removed alwaysOn fields like discovery wrapper", () => {
  const pilotHome = makeTempDir();
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
      alwaysOn: {
        enabled: true,
        discovery: { trigger: { enabled: true } },
      },
    });
    assert.throws(
      () => loadPilotConfig({ env: { PILOT_HOME: pilotHome, ANTHROPIC_API_KEY: "key" } }),
      (error) =>
        error instanceof PilotConfigError &&
        error.diagnostics.some(
          (entry) => entry.code === "ALWAYS_ON_FIELD_REMOVED" && entry.path === "alwaysOn.discovery",
        ),
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
