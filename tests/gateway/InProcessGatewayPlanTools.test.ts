import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway, SessionRouter } from "../../src/gateway/index.js";
import type { GatewaySubmitTurnInput } from "../../src/gateway/index.js";

type CapturedSubmit = {
  input: AgentInput;
  options: AgentSubmitOptions;
};

test("normal web turns do not expose plan mode tools by default", async () => {
  const captured = await submitAndCapture({
    sessionKey: "web:s_normal",
    channelKey: "web",
    message: "hello",
  });

  assert.equal(captured.input.type, "text");
  assert.equal(captured.input.text, "hello");
  assert.equal(captured.options.allowPlanModeTools, false);
});

test("explicit plan mode turns expose plan mode tools", async () => {
  const captured = await submitAndCapture({
    sessionKey: "web:s_plan",
    channelKey: "web",
    message: "plan this",
    mode: "plan",
  });

  assert.equal(captured.input.type, "text");
  assert.equal(captured.input.text, "plan this");
  assert.equal(captured.options.permissionMode, "plan");
  assert.equal(captured.options.allowPlanModeTools, true);
});

test("/plan command normalizes into a plan mode turn", async () => {
  const captured = await submitAndCapture({
    sessionKey: "web:s_slash_plan",
    channelKey: "web",
    message: "/plan do something",
  });

  assert.equal(captured.input.type, "text");
  assert.equal(captured.input.text, "do something");
  assert.equal(captured.options.permissionMode, "plan");
  assert.equal(captured.options.basePermissionMode, "default");
  assert.equal(captured.options.allowPlanModeTools, true);
});

test("allowPlanModeTools can still be explicitly overridden", async () => {
  const captured = await submitAndCapture({
    sessionKey: "api:s_override",
    channelKey: "api_server",
    message: "special caller",
    allowPlanModeTools: true,
  });

  assert.equal(captured.input.type, "text");
  assert.equal(captured.input.text, "special caller");
  assert.equal(captured.options.allowPlanModeTools, true);
});

async function submitAndCapture(input: GatewaySubmitTurnInput): Promise<CapturedSubmit> {
  let captured: CapturedSubmit | undefined;
  const router = new SessionRouter({
    createSession: async ({ sessionKey }) => fakeSession(sessionKey, (next) => {
      captured = next;
    }),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });

  for await (const _event of gateway.submitTurn(input)) {
    // Drain the stream so the gateway pump reaches session.submit().
  }

  assert.ok(captured, "expected fake session submit to be called");
  return captured;
}

function fakeSession(sessionId: string, capture: (submit: CapturedSubmit) => void): AgentSession {
  return {
    async *submit(input: AgentInput, options: AgentSubmitOptions = {}): AsyncGenerator<AgentEvent, void, unknown> {
      capture({ input, options });
      const now = new Date().toISOString();
      yield {
        type: "turn_completed",
        sessionId,
        turnId: options.turnId ?? "turn-1",
        result: {
          type: "success",
          sessionId,
          turnId: options.turnId ?? "turn-1",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: now,
          completedAt: now,
        },
      };
    },
    snapshot() {
      return {
        sessionId,
        messages: [],
        usage: {},
        permissionDenials: [],
        status: "idle",
        abortController: new AbortController(),
      };
    },
    abort() {},
  } as unknown as AgentSession;
}
