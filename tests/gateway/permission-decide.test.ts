import test from "node:test";
import assert from "node:assert/strict";
import {
  InProcessGateway,
  SessionRouter,
} from "../../src/gateway/index.js";
import type { AgentEvent, AgentSession } from "../../src/agent/index.js";

test("permissionDecide round-trips an allow decision", async () => {
  const router = new SessionRouter({
    createSession: async () => fakeSession("s-1", []),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
  const bus = gateway.getPermissionBus();

  let decided: unknown;
  bus.register("session-a", {
    requestId: "perm-1",
    toolCallId: "tc",
    toolName: "Bash",
    resolve: (decision) => {
      decided = decision;
    },
    reject: () => undefined,
  });

  const result = await gateway.permissionDecide({
    sessionKey: "session-a",
    requestId: "perm-1",
    decision: "allow",
    remember: true,
  });
  assert.equal(result.delivered, true);
  assert.deepEqual(decided, {
    requestId: "perm-1",
    decision: "allow",
    remember: true,
    reason: undefined,
  });
});

test("permissionDecide returns delivered:false for unknown requestId", async () => {
  const router = new SessionRouter({
    createSession: async () => fakeSession("s-1", []),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
  const result = await gateway.permissionDecide({
    sessionKey: "session-a",
    requestId: "missing",
    decision: "deny",
  });
  assert.equal(result.delivered, false);
});

test("permissionDecide rejects pending entries when turn ends", async () => {
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession("s-1", [
        { type: "turn_started", sessionId: "s-1", turnId: "run-1" },
        {
          type: "turn_completed",
          sessionId: "s-1",
          turnId: "run-1",
          result: {
            type: "success",
            sessionId: "s-1",
            turnId: "run-1",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      ]),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });

  let rejected: Error | undefined;
  gateway.getPermissionBus().register("session-a", {
    requestId: "perm-2",
    toolCallId: "tc",
    toolName: "Bash",
    resolve: () => undefined,
    reject: (error) => {
      rejected = error;
    },
  });

  for await (const _ of gateway.submitTurn({
    sessionKey: "session-a",
    channelKey: "web",
    message: "hi",
  })) {
    // drain
  }

  assert.match(rejected?.message ?? "", /turn_ended/);
});

function fakeSession(sessionId: string, events: AgentEvent[]): AgentSession {
  return {
    abort: () => undefined,
    snapshot: () => ({
      sessionId,
      messages: [],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    }),
    replay: async function* () {},
    submit: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as AgentSession;
}
