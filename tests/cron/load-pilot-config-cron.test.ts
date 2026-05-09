import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadPilotConfig } from "../../src/pilot/config/index.js";
import { getPilotConfigFilePath } from "../../src/pilot/paths.js";
import { validAgentConfig, validModelConfig } from "../model/helpers.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

test("loadPilotConfig surfaces cron snapshot when section is present", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-config-"));
  try {
    writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
      cron: {
        enabled: true,
        timezone: "Asia/Shanghai",
        maxConcurrentRuns: 2,
      },
    });
    const snapshot = loadPilotConfig({
      env: { PILOT_HOME: pilotHome, ANTHROPIC_API_KEY: "key" },
    });
    assert.deepEqual(snapshot.config.cron, {
      enabled: true,
      timezone: "Asia/Shanghai",
      maxConcurrentRuns: 2,
    });
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
