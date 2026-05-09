import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SUBAGENTS,
  createAgentTool,
  type AgentToolOutput,
} from "../../src/tool/builtin/agent.js";
import { PilotDeckToolRuntimeError } from "../../src/tool/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";
import type {
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/index.js";

class ScriptedModel implements PilotDeckToolModelClient {
  readonly requests: CanonicalModelRequest[] = [];
  constructor(private readonly events: CanonicalModelEvent[]) {}
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    for (const event of this.events) {
      yield event;
    }
  }
}

const cwd = "/tmp/proj";

function makeContext(model?: PilotDeckToolModelClient, signal?: AbortSignal): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: true }),
    abortSignal: signal,
    model,
  };
}

test("agent tool exposes 4 built-in subagents", () => {
  assert.deepEqual(Object.keys(BUILTIN_SUBAGENTS).sort(), ["explore", "general_purpose", "plan", "verify"]);
  for (const subagent of Object.values(BUILTIN_SUBAGENTS)) {
    assert.ok(subagent.systemPrompt.length > 20);
    assert.ok(subagent.description.length > 0);
  }
});

test("agent tool default subagentType is general_purpose", async () => {
  const model = new ScriptedModel([
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text: "answer" },
    { type: "message_end", finishReason: "stop" },
  ]);
  const tool = createAgentTool({ model });
  const result = await tool.execute(
    { description: "research", prompt: "what is X" },
    makeContext(),
  );
  const data = result.data as AgentToolOutput;
  assert.equal(data.subagentType, "general_purpose");
  assert.equal(data.text, "answer");
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0]?.systemPrompt, BUILTIN_SUBAGENTS.general_purpose.systemPrompt);
});

test("agent tool routes to specified subagentType (plan)", async () => {
  const model = new ScriptedModel([
    { type: "text_delta", text: "step 1\nstep 2" },
    { type: "message_end", finishReason: "stop" },
  ]);
  const tool = createAgentTool({ model });
  const result = await tool.execute(
    { description: "plan refactor", prompt: "Refactor the auth module.", subagentType: "plan" },
    makeContext(),
  );
  assert.equal((result.data as AgentToolOutput).subagentType, "plan");
  assert.equal(model.requests[0]?.systemPrompt, BUILTIN_SUBAGENTS.plan.systemPrompt);
});

test("agent tool reads model from context.model when factory option absent", async () => {
  const model = new ScriptedModel([
    { type: "text_delta", text: "via context" },
    { type: "message_end", finishReason: "stop" },
  ]);
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "x", prompt: "do it" },
    makeContext(model),
  );
  assert.equal((result.data as AgentToolOutput).text, "via context");
});

test("agent tool throws unsupported_tool when no model client available", async () => {
  const tool = createAgentTool();
  await assert.rejects(
    () => tool.execute({ description: "x", prompt: "do it" }, makeContext(undefined)),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "unsupported_tool" &&
      /requires a model client/.test(error.message),
  );
});

test("agent tool rejects unknown subagent type as invalid_tool_input", async () => {
  const model = new ScriptedModel([]);
  const tool = createAgentTool({ model });
  await assert.rejects(
    () =>
      tool.execute(
        // bypass type checks by casting; runtime should still reject
        { description: "x", prompt: "go", subagentType: "nope" as never },
        makeContext(),
      ),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError && error.code === "invalid_tool_input",
  );
});

test("agent tool propagates model error as tool_execution_failed", async () => {
  const model = new ScriptedModel([
    {
      type: "error",
      error: {
        provider: "edgeclaw",
        protocol: "openai",
        code: "rate_limit_error",
        message: "rate limit",
        retryable: true,
      },
    },
  ]);
  const tool = createAgentTool({ model });
  await assert.rejects(
    () => tool.execute({ description: "x", prompt: "go" }, makeContext()),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "tool_execution_failed" &&
      /rate limit/.test(error.message),
  );
});

test("agent tool aborts when context.abortSignal already aborted", async () => {
  const model = new ScriptedModel([
    { type: "text_delta", text: "ok" },
    { type: "message_end", finishReason: "stop" },
  ]);
  const tool = createAgentTool({ model });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => tool.execute({ description: "x", prompt: "go" }, makeContext(undefined, controller.signal)),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError && error.code === "tool_aborted",
  );
});

test("agent tool reports usage and provider/model in metadata", async () => {
  const model = new ScriptedModel([
    { type: "text_delta", text: "answer" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
    { type: "message_end", finishReason: "stop" },
  ]);
  const tool = createAgentTool({ model, provider: "edgeclaw", model_: "moonshotai/kimi-k2.6" });
  const result = await tool.execute({ description: "x", prompt: "go" }, makeContext());
  const data = result.data as AgentToolOutput;
  assert.deepEqual(data.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.equal(result.metadata?.provider, "edgeclaw");
  assert.equal(result.metadata?.model, "moonshotai/kimi-k2.6");
});
