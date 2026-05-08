import test from "node:test";
import assert from "node:assert/strict";
import { createModelRuntime } from "../../../src/model/index.js";
import { loadPolitConfig } from "../../../src/polit/index.js";

const RUN_REAL_MODEL_E2E = process.env.POLITDECK_RUN_REAL_MODEL_E2E === "1";

test("reads PolitHome config and completes a real model request", async (t) => {
  if (!RUN_REAL_MODEL_E2E) {
    t.skip("Set POLITDECK_RUN_REAL_MODEL_E2E=1 to run the real model E2E test.");
    return;
  }

  const snapshot = loadPolitConfig();
  const { provider, model } = snapshot.config.agent.model;
  const runtime = createModelRuntime(snapshot.config.model);

  const response = await runtime.complete({
    provider,
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Reply with exactly: PolitDeck E2E OK",
          },
        ],
      },
    ],
    // Reasoning models (Kimi K2.6, DeepSeek R1, Qwen QwQ) emit a long internal
    // chain-of-thought before any visible content; budgets under ~512 starve
    // the answer phase and produce empty `text`.
    maxOutputTokens: 1024,
    temperature: 0,
    metadata: {
      configSnapshotVersion: snapshot.version,
      test: "real-model-e2e",
    },
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  assert.equal(response.role, "assistant");
  assert.ok(text.includes("PolitDeck E2E OK"), `Unexpected model response: ${text}`);
  assert.ok(response.finishReason);
});
