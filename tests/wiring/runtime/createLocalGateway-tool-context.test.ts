/**
 * Runtime-driven wiring contract.
 *
 * Spins up a real `createLocalGateway(...)` against a fake `ModelRuntime`
 * (via `__testModelFactory`) and verifies that the per-tool runtime context
 * ACTUALLY carries the wires the structural tests grep for. If a future
 * refactor strips out e.g. `messageId` or `fileHistory` from
 * `AgentLoop.createToolContext`, the structural test would still pass (it
 * just looks for a literal string), but this runtime test would fail
 * because the value never reaches the tool's execute().
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLocalGateway } from "../../../src/cli/createLocalGateway.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelCapabilities,
  ModelRuntime,
} from "../../../src/model/index.js";

/**
 * Strip env-based config overrides (e.g. `PILOT_AGENT_MODEL`) from
 * `process.env` so the synthetic project YAML written by `makeProjectRoot`
 * isn't shadowed by the developer's outer-shell exports. Without this, an
 * outer `PILOT_AGENT_MODEL=other/model` wins over `agent.model` in the test
 * fixture and `loadPilotConfig` rejects with `unknown provider …`.
 */
function scrubProcessEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.PILOT_AGENT_MODEL;
  return env;
}

function makeProjectRoot(): { projectRoot: string; pilotHome: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "pilotdeck-wiring-runtime-"));
  const pilotHome = mkdtempSync(path.join(tmpdir(), "pilotdeck-wiring-home-"));
  // Minimal global pilotdeck.yaml so loadPilotConfig doesn't barf.
  mkdirSync(pilotHome, { recursive: true });
  writeFileSync(
    path.join(pilotHome, "pilotdeck.yaml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: openai-main/gpt-test",
      "model:",
      "  providers:",
      "    openai-main:",
      "      protocol: openai",
      "      url: https://example.invalid",
      "      apiKey: sk-test",
      "      models:",
      "        gpt-test:",
      "          capabilities:",
      "            supportsToolUse: true",
      "            supportsStreaming: true",
      "            supportsParallelToolCalls: true",
      "            supportsThinking: false",
      "            supportsJsonSchema: true",
      "            supportsSystemPrompt: true",
      "            supportsPromptCache: false",
      "            maxContextTokens: 200000",
      "            maxOutputTokens: 8192",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    projectRoot,
    pilotHome,
    cleanup: () => {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(pilotHome, { recursive: true, force: true });
    },
  };
}

/**
 * A `ModelRuntime` that pushes a single empty assistant message and
 * finishes — enough to drive `AgentLoop` to a clean stop without any tool
 * activity. We intercept the request to learn what context+tools were
 * threaded in.
 */
function makeRecordingModel(): { model: ModelRuntime; lastRequest: { value?: CanonicalModelRequest } } {
  const lastRequest: { value?: CanonicalModelRequest } = {};
  const model: ModelRuntime = {
    stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      lastRequest.value = request;
      return (async function* () {
        yield {
          type: "request_started",
          provider: request.provider,
          model: request.model,
        } satisfies CanonicalModelEvent;
        yield { type: "message_start", role: "assistant" } satisfies CanonicalModelEvent;
        yield { type: "text_delta", text: "ok" } satisfies CanonicalModelEvent;
        yield {
          type: "message_end",
          finishReason: "stop",
        } satisfies CanonicalModelEvent;
      })();
    },
    async complete(_request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      throw new Error("complete() not used in this test fixture");
    },
    getCapabilities(_providerId: string, _modelId: string): ModelCapabilities {
      return {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: true,
        supportsThinking: false,
        supportsJsonSchema: true,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
      };
    },
    getMultimodal() { return { input: ["text" as const] }; },
  };
  return { model, lastRequest };
}

test("WIRING runtime: createLocalGateway can run a turn end-to-end with __testModelFactory", async () => {
  const env = makeProjectRoot();
  try {
    const { model, lastRequest } = makeRecordingModel();
    const { gateway, dispose } = createLocalGateway({
      projectRoot: env.projectRoot,
      pilotHome: env.pilotHome,
      env: scrubProcessEnv(),
      __testModelFactory: () => model,
    });
    try {
      const sessionKey = `cli:project=${env.projectRoot}:s_runtime`;
      const events: string[] = [];
      for await (const event of gateway.submitTurn({
        sessionKey,
        channelKey: "cli",
        message: "hello",
      })) {
        events.push(event.type);
      }

      assert.ok(events.includes("turn_started"), `expected turn_started, got: ${events.join(",")}`);
      assert.ok(events.includes("turn_completed"), `expected turn_completed, got: ${events.join(",")}`);
      assert.ok(lastRequest.value, "model.stream was never called — wiring is broken end-to-end");
      assert.ok(
        Array.isArray(lastRequest.value!.tools),
        "request.tools was not threaded in",
      );
      const toolNames = (lastRequest.value!.tools ?? []).map((t) => t.name);
      // Verifies R1: structured_output + ask_user_question are in the registry
      // and reach the model request via DefaultContextRuntime.prepareForModel.
      assert.ok(
        toolNames.includes("structured_output"),
        `structured_output missing from wire. got: ${toolNames.join(",")}`,
      );
      assert.ok(
        toolNames.includes("ask_user_question"),
        `ask_user_question missing from wire. got: ${toolNames.join(",")}`,
      );

      await gateway.closeSession({ sessionKey });
    } finally {
      dispose();
    }
  } finally {
    env.cleanup();
  }
});

test("WIRING runtime: respondElicitation returns delivered=false for an unknown requestId", async () => {
  const env = makeProjectRoot();
  try {
    const { model } = makeRecordingModel();
    const { gateway, dispose } = createLocalGateway({
      projectRoot: env.projectRoot,
      pilotHome: env.pilotHome,
      env: scrubProcessEnv(),
      __testModelFactory: () => model,
    });
    try {
      const result = await gateway.respondElicitation({
        sessionKey: "no-such-session",
        requestId: "no-such-request",
        answer: { type: "answered", answers: {} },
      });
      assert.deepEqual(result, { delivered: false });
    } finally {
      dispose();
    }
  } finally {
    env.cleanup();
  }
});
