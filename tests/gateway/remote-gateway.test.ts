import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InProcessGateway, RemoteGateway, SessionRouter, startGatewayServer, GatewayWsClient } from "../../src/gateway/index.js";
import type { AgentEvent, AgentSession } from "../../src/agent/index.js";

test("RemoteGateway streams events through GatewayServer WebSocket", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "politdeck-gateway-"));
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession("session-1", [
        { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
        {
          type: "model_event",
          sessionId: "session-1",
          turnId: "run-1",
          event: { type: "text_delta", text: "remote hello" },
        },
        {
          type: "turn_completed",
          sessionId: "session-1",
          turnId: "run-1",
          result: {
            type: "success",
            sessionId: "session-1",
            turnId: "run-1",
            stopReason: "completed",
            usage: { totalTokens: 2 },
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      ]),
  });
  const server = await startGatewayServer({
    gateway: new InProcessGateway(router, { uuid: () => "run-1" }),
    port: 0,
    tokenPath: join(tempDir, "server-token"),
  });

  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  try {
    await client.connect();
    const gateway = new RemoteGateway(client);
    const events = await collect(
      gateway.submitTurn({
        sessionKey: "session-1",
        channelKey: "cli",
        message: "hello",
        runId: "run-1",
      }),
    );

    assert.deepEqual(events, [
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "remote hello" },
      { type: "turn_completed", usage: { totalTokens: 2 }, finishReason: "completed" },
    ]);
  } finally {
    client.close();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

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
