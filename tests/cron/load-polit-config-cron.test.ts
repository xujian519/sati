import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadPolitConfig } from "../../src/polit/config/index.js";
import { getPolitConfigFilePath } from "../../src/polit/paths.js";
import { validAgentConfig, validModelConfig } from "../model/helpers.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

test("loadPolitConfig surfaces cron snapshot when section is present", () => {
  const politHome = mkdtempSync(join(tmpdir(), "politdeck-cron-config-"));
  try {
    writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
      cron: {
        enabled: true,
        timezone: "Asia/Shanghai",
        maxConcurrentRuns: 2,
      },
    });
    const snapshot = loadPolitConfig({
      env: { POLIT_HOME: politHome, ANTHROPIC_API_KEY: "key" },
    });
    assert.deepEqual(snapshot.config.cron, {
      enabled: true,
      timezone: "Asia/Shanghai",
      maxConcurrentRuns: 2,
    });
  } finally {
    rmSync(politHome, { recursive: true, force: true });
  }
});
