import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotConfig } from "../../src/pilot/config/index.js";

// apps/desktop compiles to CommonJS; load built output (release runs `npm run build` in apps/desktop first).
const require = createRequire(import.meta.url);
const { buildConfigYaml } = require("../../apps/desktop/dist/onboarding-config.js") as {
  buildConfigYaml: (p: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }) => string;
};

test("desktop onboarding YAML uses V2 schema and passes loadPilotConfig", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-onboard-"));
  try {
    const yaml = buildConfigYaml({
      providerType: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test-onboarding-smoke",
      model: "claude-sonnet-4-5-20250929",
    });

    assert.match(yaml, /schemaVersion:\s*1/);
    assert.match(yaml, /agent:\s*\n\s+model:\s*pilotdeck\//);
    assert.match(yaml, /model:\s*\n\s+providers:/);
    assert.doesNotMatch(yaml, /^version:/m);
    assert.doesNotMatch(yaml, /^models:/m);
    assert.doesNotMatch(yaml, /^agents:/m);

    const configPath = join(pilotHome, "pilotdeck.yaml");
    mkdirSync(pilotHome, { recursive: true });
    writeFileSync(configPath, yaml, "utf8");

    const snapshot = loadPilotConfig({
      env: { PILOT_HOME: pilotHome },
    });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.config.agent.model.provider, "pilotdeck");
    assert.equal(snapshot.config.agent.model.model, "claude-sonnet-4-5-20250929");
    assert.equal(
      snapshot.config.model.providers.pilotdeck.protocol,
      "anthropic",
    );
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("openai-chat provider maps to openai protocol", () => {
  const yaml = buildConfigYaml({
    providerType: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-openai-test",
    model: "gpt-4o",
  });
  assert.match(yaml, /protocol:\s*openai/);
  assert.match(yaml, /model:\s*pilotdeck\/gpt-4o/);
});
