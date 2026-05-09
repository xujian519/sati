import test from "node:test";
import assert from "node:assert/strict";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { createModelRuntime } from "../../../src/model/index.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

const RUN = process.env.PILOTDECK_RUN_REAL_CONTEXT_E2E === "1";
const PROVIDER = process.env.PILOTDECK_E2E_PROVIDER ?? "edgeclaw";
const MODEL = process.env.PILOTDECK_E2E_MODEL ?? "moonshotai/kimi-k2.6";

test(
  "DefaultContextRuntime + real OpenRouter Kimi K2.6 returns a coherent reply when PromptAssembler builds the system prompt",
  { timeout: 120_000 },
  async (t) => {
    if (!RUN) {
      t.skip("Set PILOTDECK_RUN_REAL_CONTEXT_E2E=1 to run the OpenRouter context E2E test.");
      return;
    }

    const snapshot = loadPilotConfig();
    const provider = snapshot.config.model.providers[PROVIDER];
    if (!provider) {
      throw new Error(`Provider ${PROVIDER} is not configured in PilotHome.`);
    }
    if (!provider.models[MODEL]) {
      throw new Error(`Model ${MODEL} is not configured under provider ${PROVIDER}.`);
    }

    const runtime = new DefaultContextRuntime();
    const messages: CanonicalMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "You're PilotDeck talking to a CI test. Reply with exactly 'PilotDeck-OK' and nothing else.",
          },
        ],
      },
    ];

    const context = await runtime.prepareForModel({
      sessionId: "session-context-e2e",
      turnId: "turn-context-e2e",
      cwd: process.cwd(),
      provider: PROVIDER,
      model: MODEL,
      permissionMode: "default",
      additionalWorkingDirectories: [],
      messages,
      tools: [
        { name: "add_numbers", description: "Add two numbers.", inputSchema: { type: "object" } },
      ],
    });

    assert.match(context.systemPrompt!, /You are PilotDeck/);
    assert.match(context.systemPrompt!, /add_numbers/);
    assert.match(context.systemPrompt!, /<user-context>/);
    assert.equal(context.tools.length, 1);

    const modelRuntime = createModelRuntime(snapshot.config.model);
    let text = "";
    for await (const event of modelRuntime.stream({
      provider: PROVIDER,
      model: MODEL,
      messages: context.messages,
      systemPrompt: context.systemPrompt,
      maxOutputTokens: 64,
      temperature: 0,
      stream: true,
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") throw new Error(event.error.message);
    }
    assert.match(text, /PilotDeck-OK/);
  },
);
