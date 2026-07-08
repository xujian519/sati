import test from "node:test";
import assert from "node:assert/strict";
import { mapAgentEvent } from "../../src/gateway/index.js";
import type { AgentEvent } from "../../src/agent/index.js";

test("turn_failed exposes provider raw error", () => {
  const event: AgentEvent = {
    type: "turn_failed",
    sessionId: "s",
    turnId: "t",
    error: {
      code: "agent_model_error",
      message: "provider failed",
      details: {
        provider: "llm-center",
        protocol: "openai",
        code: "invalid_request",
        status: 400,
        message: "Range of max_tokens should be [1, 32768]",
        retryable: false,
        raw: {
          error: {
            message: "bad token sk-1234567890abcdef and auth Bearer abcdefghijklmnopqrstuvwxyz",
            authorization: "Bearer should-not-leak",
          },
        },
      },
    },
  };

  const [mapped] = mapAgentEvent(event, "run-1");
  assert.equal(mapped?.type, "error");
  if (mapped?.type !== "error") throw new Error("expected error event");
  assert.equal(mapped.providerError?.provider, "llm-center");
  assert.equal(mapped.providerError?.status, 400);
  assert.match(mapped.providerError?.raw ?? "", /sk-1234567890abcdef/);
  assert.match(mapped.providerError?.raw ?? "", /should-not-leak/);
  assert.match(mapped.providerError?.raw ?? "", /abcdefghijklmnopqrstuvwxyz/);
});

test("recovery events map to agent_status", () => {
  const events: AgentEvent[] = [
    {
      type: "token_cap_adjusted",
      sessionId: "s",
      turnId: "t",
      provider: "p",
      model: "m",
      cap: "output",
      previous: 65_536,
      next: 32_768,
      reason: "provider-output-cap",
    },
    {
      type: "empty_output_recovery",
      sessionId: "s",
      turnId: "t",
      provider: "p",
      model: "m",
      finishReason: "length",
      previousMaxOutputTokens: 1,
      nextMaxOutputTokens: 4_096,
    },
  ];

  const mapped = events.flatMap((event) => mapAgentEvent(event, "run-1"));
  assert.equal(mapped[0]?.type, "agent_status");
  assert.equal(mapped[0]?.type === "agent_status" ? mapped[0].event : undefined, "token_cap_adjusted");
  assert.equal(mapped[1]?.type, "agent_status");
  assert.equal(mapped[1]?.type === "agent_status" ? mapped[1].event : undefined, "empty_output_recovery");
});
