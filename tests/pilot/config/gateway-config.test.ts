import test from "node:test";
import assert from "node:assert/strict";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validAgentConfig, validModelConfig } from "../../model/helpers.js";

test("loads gateway and adapters config", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-config-"));
  try {
    await writeFile(
      join(pilotHome, "pilotdeck.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        agent: validAgentConfig(),
        model: validModelConfig(),
        gateway: {
          port: 18888,
          bindAddress: "127.0.0.1",
          tokenPath: "/tmp/legacy-token",
        },
        adapters: {
          cli: { autoConnectServer: true },
          feishu: { enabled: true, defaultSessionLabel: "general" },
        },
      }),
    );

    const snapshot = loadPilotConfig({ env: { PILOT_HOME: pilotHome, ANTHROPIC_API_KEY: "anthropic-key" } });

    assert.equal(snapshot.config.gateway?.port, 18888);
    assert.equal(snapshot.config.gateway?.bindAddress, "127.0.0.1");
    assert.equal("tokenPath" in snapshot.config.gateway!, false);
    assert.equal(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === "GATEWAY_TOKEN_PATH_REMOVED"),
      true,
    );
    assert.equal(snapshot.config.adapters?.cli?.autoConnectServer, true);
    assert.equal(snapshot.config.adapters?.feishu?.enabled, true);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});
