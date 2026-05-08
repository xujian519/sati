import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../../src/agent/index.js";
import { LifecycleRuntime, emptyLifecycleDispatchResult, type LifecycleDispatchInput, type LifecycleDispatchResult } from "../../src/lifecycle/index.js";
import { createAgentLoopFixture, collectAsyncGenerator } from "../helpers/agent.js";

class RecordingLifecycleRuntime extends LifecycleRuntime {
  readonly calls: LifecycleDispatchInput[] = [];

  constructor(private readonly handler: (input: LifecycleDispatchInput) => LifecycleDispatchResult = emptyLifecycleDispatchResult) {
    super();
  }

  override async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult> {
    this.calls.push(input);
    return this.handler(input);
  }
}

test("AgentLoop runs Stop hooks before completing a no-tool turn", async () => {
  const lifecycle = new RecordingLifecycleRuntime((input) => {
    if (input.event !== "Stop") return emptyLifecycleDispatchResult();
    return {
      ...emptyLifecycleDispatchResult(),
      effects: [{ type: "block", reason: "stop hook blocked", stopReason: "blocked" }],
    };
  });
  const { loop } = createAgentLoopFixture({
    lifecycle,
    scripts: [[
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "done" },
      { type: "message_end", finishReason: "stop" },
    ]],
  });

  const { values, result } = await collectAsyncGenerator(loop.run({
    sessionId: "session",
    turnId: "turn",
    messages: [],
  }));

  assert.equal(lifecycle.calls.some((call) => call.event === "Stop"), true);
  assert.equal(result.result.type, "error");
  assert.equal(values.some((event) => event.type === "turn_failed"), true);
});

test("AgentLoop runs StopFailure hooks for terminal model errors", async () => {
  const lifecycle = new RecordingLifecycleRuntime();
  const { loop } = createAgentLoopFixture({
    lifecycle,
    scripts: [[
      { type: "message_start", role: "assistant" },
      {
        type: "error",
        error: {
          provider: "test",
          protocol: "anthropic",
          code: "bad_request",
          message: "bad model",
          retryable: false,
        },
      },
    ]],
  });

  await collectAsyncGenerator(loop.run({
    sessionId: "session",
    turnId: "turn",
    messages: [],
  }));

  assert.equal(lifecycle.calls.some((call) => call.event === "StopFailure"), true);
});

test("AgentSession dispatches SessionEnd after submit completes", async () => {
  const lifecycle = new RecordingLifecycleRuntime();
  const { turnRunner } = createAgentLoopFixture({
    lifecycle,
    scripts: [[
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "done" },
      { type: "message_end", finishReason: "stop" },
    ]],
  });
  const session = new AgentSession({
    sessionId: "session",
    turnRunner,
    uuid: () => "turn",
    lifecycle,
  });

  await collectAsyncGenerator(session.submit({ type: "text", text: "hello" }));

  assert.deepEqual(lifecycle.calls.map((call) => call.event), [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
  ]);
});
