import test from "node:test";
import assert from "node:assert/strict";
import { loadPolitConfig } from "../../../src/polit/index.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validAgentConfig, validModelConfig } from "../../model/helpers.js";

test("loads gateway and adapters config", async () => {
  const politHome = await mkdtemp(join(tmpdir(), "politdeck-config-"));
  try {
    await writeFile(
      join(politHome, "politdeck.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        agent: validAgentConfig(),
        model: validModelConfig(),
        gateway: {
          port: 18888,
          bindAddress: "127.0.0.1",
        },
        adapters: {
          cli: { autoConnectServer: true },
          feishu: { enabled: true, defaultSessionLabel: "general" },
        },
      }),
    );

    const snapshot = loadPolitConfig({ env: { POLIT_HOME: politHome, ANTHROPIC_API_KEY: "anthropic-key" } });

    assert.equal(snapshot.config.gateway?.port, 18888);
    assert.equal(snapshot.config.gateway?.bindAddress, "127.0.0.1");
    assert.equal(snapshot.config.adapters?.cli?.autoConnectServer, true);
    assert.equal(snapshot.config.adapters?.feishu?.enabled, true);
  } finally {
    await rm(politHome, { recursive: true, force: true });
  }
});
