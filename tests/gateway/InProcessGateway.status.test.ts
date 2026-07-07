import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { GatewayEvent, GatewayRecordAgentStatusMessageInput } from "../../src/gateway/protocol/types.js";

function createFailingSession(sessionId: string): AgentSession {
  return {
    async *submit(): AsyncGenerator<never, void, unknown> {
      throw new Error("submit exploded");
    },
    abort(): void {},
    snapshot() {
      return {
        sessionId,
        messages: [],
        usage: {},
        permissionDenials: [],
        status: "failed" as const,
        abortController: new AbortController(),
      };
    },
    snapshotForRuntimeReload() {
      throw new Error("not used");
    },
    async *replay(): AsyncGenerator<never, void, unknown> {},
  } as unknown as AgentSession;
}

test("gateway emits and records semantic status before gateway_submit_failed error", async () => {
  const recorded: GatewayRecordAgentStatusMessageInput[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: ({ sessionKey }) => createFailingSession(sessionKey),
  });
  const gateway = new InProcessGateway(router, {
    recordAgentStatusMessage: async (input) => {
      recorded.push(input);
      return { recorded: true };
    },
  });

  const events: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "test:s_gateway",
    channelKey: "test",
    message: "hello",
    runId: "turn-1",
  })) {
    events.push(event);
  }
  router.shutdown();

  assert.equal(events[0]?.type, "agent_status");
  assert.equal(events[0]?.type === "agent_status" ? events[0].event : undefined, "gateway_submit_failed");
  assert.equal(events[1]?.type, "error");
  assert.equal(events[1]?.type === "error" ? events[1].code : undefined, "gateway_submit_failed");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.status.event, "gateway_submit_failed");
  assert.equal(recorded[0]?.status.detail?.visible, true);
  assert.equal(recorded[0]?.status.detail?.code, "gateway_submit_failed");
});
