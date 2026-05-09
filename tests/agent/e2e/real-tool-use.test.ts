import test from "node:test";
import assert from "node:assert/strict";
import { collectAsyncGenerator } from "../../helpers/agent.js";
import { createPolitDeckTestTool } from "../../helpers/tool.js";
import { AgentLoop, type AgentRuntimeConfig, type AgentRuntimeDependencies } from "../../../src/agent/index.js";
import { createModelRuntime } from "../../../src/model/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { loadPolitConfig } from "../../../src/polit/index.js";
import { createRouterRuntime } from "../../../src/router/index.js";
import { SequentialToolScheduler, ToolRegistry, ToolRuntime } from "../../../src/tool/index.js";

const RUN = process.env.POLITDECK_RUN_REAL_TOOL_E2E === "1";
const PROVIDER = process.env.POLITDECK_E2E_PROVIDER ?? "edgeclaw";
const MODEL = process.env.POLITDECK_E2E_MODEL ?? "moonshotai/kimi-k2.6";

test("OpenRouter Kimi K2.6 calls add_numbers tool and replies with the sum", { timeout: 120_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set POLITDECK_RUN_REAL_TOOL_E2E=1 to run the OpenRouter tool-use E2E test.");
    return;
  }

  const snapshot = loadPolitConfig();
  const provider = snapshot.config.model.providers[PROVIDER];
  if (!provider) {
    throw new Error(`Provider ${PROVIDER} is not configured in PolitHome.`);
  }
  if (!provider.models[MODEL]) {
    throw new Error(`Model ${MODEL} is not configured under provider ${PROVIDER}.`);
  }

  const cwd = process.cwd();
  const registry = new ToolRegistry();
  const calls: Array<{ a: number; b: number }> = [];
  registry.register(
    createPolitDeckTestTool({
      name: "add_numbers",
      inputSchema: {
        type: "object",
        required: ["a", "b"],
        additionalProperties: false,
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
      },
      execute: async (input) => {
        const { a, b } = input as { a: number; b: number };
        calls.push({ a, b });
        return { content: [{ type: "text", text: String(a + b) }], data: { sum: a + b } };
      },
    }),
  );

  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const modelRuntime = createModelRuntime(snapshot.config.model);

  const config: AgentRuntimeConfig = {
    provider: PROVIDER,
    model: MODEL,
    cwd,
    systemPrompt:
      "You are PolitDeck running an end-to-end test. When asked for arithmetic, you MUST call the provided add_numbers tool exactly once instead of computing it yourself, then report the answer.",
    maxOutputTokens: 1024,
    temperature: 0,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
    metadata: { test: "openrouter-kimi-k2.6-tool-use" },
  };
  const router = createRouterRuntime(
    snapshot.config.router ?? {
      scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } },
    },
    { modelRuntime },
  );
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: { registry, scheduler },
  };

  const loop = new AgentLoop(config, dependencies);
  const { values, result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "session-e2e",
      turnId: "turn-e2e",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Use the add_numbers tool to compute 17 + 25 and tell me the result.",
            },
          ],
        },
      ],
      maxTurns: 3,
    }),
  );

  assert.equal(result.result.type, "success", `Turn did not succeed: ${JSON.stringify(result.result)}`);
  assert.ok(calls.length >= 1, "Expected the model to call add_numbers at least once.");
  assert.deepEqual(calls[0], { a: 17, b: 25 });
  const finalText =
    (result.result.finalMessage?.content ?? [])
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? "";
  assert.match(finalText, /42/, `Final assistant text did not include the sum: ${finalText}`);
  assert.ok(values.some((event) => event.type === "tool_calls_detected"));
  assert.ok(values.some((event) => event.type === "tool_result"));
});
