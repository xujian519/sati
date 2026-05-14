/**
 * `abort-turn` parity scenario.
 *
 * Wires `GatewayBrowserClient.abortTurn` against an in-process gateway
 * holding a fake session whose stream blocks until aborted. Confirms:
 *   1) abortTurn resolves successfully.
 *   2) The submit_turn stream surfaces the abort as an `error` event with
 *      code "agent_aborted" (per `mapAgentEvent`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  InProcessGateway,
  SessionRouter,
  startGatewayServer,
} from "../../src/gateway/index.js";
import type { AgentEvent, AgentSession } from "../../src/agent/index.js";
import { GatewayBrowserClient } from "../../src/web/client/index.js";

test("abort-turn surfaces as an `error` event in the browser stream", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = new SessionRouter({
    createSession: async () =>
      ({
        abort: () => release(),
        snapshot: () => ({
          sessionId: "s-1",
          messages: [],
          usage: {},
          permissionDenials: [],
          status: "idle",
          abortController: new AbortController(),
        }),
        replay: async function* () {},
        submit: async function* () {
          yield { type: "turn_started", sessionId: "s-1", turnId: "run-1" } satisfies AgentEvent;
          await blocker;
          yield {
            type: "session_aborted",
            sessionId: "s-1",
            reason: "aborted_by_test",
          } satisfies AgentEvent;
        },
      }) as unknown as AgentSession,
  });

  const server = await startGatewayServer({
    gateway: new InProcessGateway(router, { uuid: () => "run-1" }),
    port: 0,
    token: "abort-token",
  });
  const client = new GatewayBrowserClient({
    url: server.wsUrl,
    token: server.token,
    clientName: "test",
  });

  try {
    await client.connect();
    const stream = client.submitTurn({
      sessionKey: "s-1",
      channelKey: "web",
      message: "do something slow",
      runId: "run-1",
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, "turn_started");

    await client.abortTurn({ sessionKey: "s-1", runId: "run-1" });
    release();
    const events: string[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value.type);
    }
    assert.ok(events.includes("error"), `expected error event, got: ${events.join(", ")}`);
  } finally {
    client.close();
    await server.close();
  }
});
