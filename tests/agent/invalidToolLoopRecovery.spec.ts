import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession } from "../../src/agent/index.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { RouterDecision } from "../../src/router/index.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

type ScriptedResponse =
  | { type: "tool"; input: Record<string, unknown>; id?: string }
  | { type: "text"; text: string };

function createScriptedRouter(responses: ScriptedResponse[], requests: CanonicalModelRequest[]): AgentRouterRuntime {
  let responseIndex = 0;
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    } satisfies RouterDecision),
    execute: async function* (_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      const response = responses[Math.min(responseIndex, responses.length - 1)]!;
      responseIndex += 1;
      yield { type: "message_start", role: "assistant" };
      if (response.type === "text") {
        yield { type: "text_delta", text: response.text };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      const id = response.id ?? `invalid-execute-code-${responseIndex}`;
      const toolCall = { id, name: "execute_code", input: response.input };
      yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
      yield { type: "tool_call_end", toolCall };
      yield { type: "message_end", finishReason: "tool_call" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
}

async function runScriptedAgent(responses: ScriptedResponse[], maxTurns: number): Promise<{
  events: AgentEvent[];
  requests: CanonicalModelRequest[];
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-invalid-loop-"));
  const requests: CanonicalModelRequest[] = [];
  try {
    const registry = createBuiltinRegistry({ webSearch: false, webFetch: false, agent: false, askUserQuestion: false });
    const session = createAgentSession({
      sessionId: "invalid-tool-loop-session",
      config: {
        provider: "test",
        model: "fake-model",
        cwd,
        permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
      },
      dependencies: {
        router: createScriptedRouter(responses, requests),
        tools: { registry },
        now: () => new Date("2026-07-04T00:00:00.000Z"),
        uuid: (() => {
          let id = 0;
          return () => `test-id-${++id}`;
        })(),
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "exercise invalid tool recovery" }, { maxTurns })) {
      events.push(event);
    }
    return { events, requests };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function requestText(request: CanonicalModelRequest): string {
  return request.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("repeated identical invalid tool inputs receive one grace prompt before circuit-breaking", async () => {
  const invalidMissingCode = { description: "missing required code" };
  const { events, requests } = await runScriptedAgent([
    { type: "tool", input: invalidMissingCode },
    { type: "tool", input: invalidMissingCode },
    { type: "tool", input: invalidMissingCode },
    { type: "tool", input: invalidMissingCode },
  ], 8);

  assert.equal(events.filter((event) => event.type === "tool_result" && event.result.type === "error").length, 4);
  assert.equal(events.filter((event) => event.type === "turn_continued" && event.reason === "model_error").length, 1);
  assert.ok(
    requests.some((request) => requestText(request).includes("Your last several tool calls all failed input validation with the same error.")),
    "expected the follow-up model request to include the invalid-input grace prompt",
  );
  const failed = events.find((event): event is Extract<AgentEvent, { type: "turn_failed" }> => event.type === "turn_failed");
  assert.ok(failed, "expected repeated identical invalid inputs to eventually fail");
  assert.equal(failed.error.code, "agent_tool_error_loop");
  assert.match(failed.error.message, /identical tool input validation failures/);
});

test("changed invalid fingerprints do not consume the repeated-invalid grace period", async () => {
  const { events, requests } = await runScriptedAgent([
    { type: "tool", input: { description: "missing required code" } },
    { type: "tool", input: { code: 123 } },
    { type: "tool", input: { description: "missing required code" } },
    { type: "text", text: "I changed strategy instead of repeating the invalid call." },
  ], 8);

  assert.equal(events.filter((event) => event.type === "turn_continued" && event.reason === "model_error").length, 0);
  assert.ok(!requests.some((request) => requestText(request).includes("Your last several tool calls all failed input validation")));
  assert.ok(!events.some((event) => event.type === "turn_failed"));
  assert.ok(events.some((event) => event.type === "turn_completed" && event.result.type === "success"));
});

