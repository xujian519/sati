import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEdgeClawMemoryProviderFromConfig } from "../../src/context/index.js";
import type { PilotMemoryConfig } from "../../src/pilot/config/types.js";
import { parseModelConfig } from "../../src/model/config/parseModelConfig.js";
import { validModelConfig } from "../model/helpers.js";

test("createEdgeClawMemoryProviderFromConfig forwards schedule and heartbeat settings to core", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-memory-factory-"));
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  let created: ReturnType<typeof createEdgeClawMemoryProviderFromConfig> | undefined;

  try {
    const config: PilotMemoryConfig = {
      enabled: true,
      provider: "edgeclaw",
      rootDir: join(root, "memory-root"),
      captureStrategy: "last_turn",
      includeAssistant: true,
      maxMessageChars: 6000,
      model: "openai-main/gpt-5.1",
      apiType: "openai-completions",
      heartbeatBatchSize: 9,
      schedule: {
        reasoningMode: "accuracy_first",
        autoIndexIntervalMinutes: 2,
        autoDreamIntervalMinutes: 4,
      },
    };

    created = createEdgeClawMemoryProviderFromConfig({
      config,
      modelConfig: parseModelConfig(validModelConfig(), { env: { ANTHROPIC_API_KEY: "anthropic-key" } }),
      projectRoot,
    });

    assert.ok(created, "expected memory provider to be created");
    assert.deepEqual(created.service.getSettings(), {
      reasoningMode: "accuracy_first",
      autoIndexIntervalMinutes: 2,
      autoDreamIntervalMinutes: 4,
    });
    const batchSize = (created.service as unknown as { indexer: { batchSize: number } }).indexer.batchSize;
    assert.equal(batchSize, 9);
  } finally {
    created?.service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
