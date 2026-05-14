import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { InstructionDiscovery } from "../../../src/context/instructions/InstructionDiscovery.js";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { createModelRuntime } from "../../../src/model/index.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

const RUN = process.env.PILOTDECK_RUN_REAL_CONTEXT_E2E === "1";
const PROVIDER = process.env.PILOTDECK_E2E_PROVIDER ?? "openrouter";
const MODEL = process.env.PILOTDECK_E2E_MODEL ?? "deepseek/deepseek-v4-flash";

const MARKER = "XYZZY-PILOTDECK-CANARY-42";

test(
  "E2E: InstructionDiscovery injects PILOTDECK.md into system prompt and model can see it",
  { timeout: 120_000 },
  async (t) => {
    if (!RUN) {
      t.skip("Set PILOTDECK_RUN_REAL_CONTEXT_E2E=1 to run.");
      return;
    }

    const snapshot = loadPilotConfig();
    const provider = snapshot.config.model.providers[PROVIDER];
    if (!provider) throw new Error(`Provider ${PROVIDER} not configured.`);
    if (!provider.models[MODEL]) throw new Error(`Model ${MODEL} not configured under ${PROVIDER}.`);

    const dir = await mkdtemp(join(tmpdir(), "pilotdeck-e2e-instr-"));
    try {
      const projectRoot = join(dir, "project");
      const pilotHome = join(dir, "home");
      await mkdir(projectRoot, { recursive: true });
      await mkdir(pilotHome, { recursive: true });

      await writeFile(
        join(pilotHome, "PILOTDECK.md"),
        `Secret canary marker: ${MARKER}\nAlways respond in Chinese.`,
      );
      await writeFile(
        join(projectRoot, "PILOTDECK.md"),
        "This project uses TypeScript strict mode with no-any rule.",
      );

      const instructionDiscovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
      const runtime = new DefaultContextRuntime({ instructionDiscovery });

      const messages: CanonicalMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "This is an E2E test. Your system prompt contains a <project-instructions> section with PILOTDECK.md contents.",
                `Look for a line that says "Secret canary marker: ..." and reply with EXACTLY that marker string (the part after the colon, trimmed).`,
                "Reply with ONLY the marker, nothing else.",
              ].join("\n"),
            },
          ],
        },
      ];

      const context = await runtime.prepareForModel({
        sessionId: "e2e-instruction-discovery",
        turnId: "turn-1",
        cwd: projectRoot,
        provider: PROVIDER,
        model: MODEL,
        permissionMode: "default",
        additionalWorkingDirectories: [],
        messages,
        tools: [],
      });

      // Phase 1: verify system prompt contains our content
      assert.ok(
        context.systemPrompt!.includes(MARKER),
        `system prompt must contain marker ${MARKER}`,
      );
      assert.ok(
        context.systemPrompt!.includes("<project-instructions>"),
        "system prompt must contain <project-instructions> wrapper",
      );
      assert.ok(
        context.systemPrompt!.includes("TypeScript strict mode"),
        "system prompt must contain project-level instruction",
      );

      console.log("--- System prompt snippet (last 800 chars) ---");
      console.log(context.systemPrompt!.slice(-800));
      console.log("--- end snippet ---");

      // Phase 2: ask model to echo the marker
      const modelRuntime = createModelRuntime(snapshot.config.model);
      let text = "";
      for await (const event of modelRuntime.stream({
        provider: PROVIDER,
        model: MODEL,
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        maxOutputTokens: 128,
        temperature: 0,
        stream: true,
      })) {
        if (event.type === "text_delta") text += event.text;
        if (event.type === "error") throw new Error(event.error.message);
      }

      console.log(`Model replied: "${text.trim()}"`);
      assert.ok(
        text.includes(MARKER),
        `Model should echo the canary marker. Got: "${text.trim()}"`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
