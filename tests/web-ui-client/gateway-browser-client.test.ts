import test from "node:test";
import assert from "node:assert/strict";
import { InProcessGateway, SessionRouter, startGatewayServer } from "../../src/gateway/index.js";
import type { AgentEvent, AgentSession } from "../../src/agent/index.js";
import { GatewayBrowserClient } from "../../src/web/client/index.js";

test("GatewayBrowserClient streams submit_turn events end-to-end", async () => {
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession("s-1", [
        { type: "turn_started", sessionId: "s-1", turnId: "run-1" },
        {
          type: "model_event",
          sessionId: "s-1",
          turnId: "run-1",
          event: { type: "text_delta", text: "browser hello" },
        },
        {
          type: "turn_completed",
          sessionId: "s-1",
          turnId: "run-1",
          result: {
            type: "success",
            sessionId: "s-1",
            turnId: "run-1",
            stopReason: "completed",
            usage: { totalTokens: 1 },
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
    token: "browser-token",
  });

  const client = new GatewayBrowserClient({
    url: server.wsUrl,
    token: server.token,
    clientName: "test",
  });

  try {
    await client.connect();
    assert.equal(client.connected, true);
    const stream = client.submitTurn({
      sessionKey: "s-1",
      channelKey: "web",
      message: "hi",
      runId: "run-1",
    });
    const events = await collect(stream);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "turn_started",
        "assistant_text_delta",
        // GatewayWsConnection emits a synthetic `final: true` turn_completed
        // after the real one; the browser client drops the synthetic copy
        // so the stream ends with exactly one `turn_completed` here.
        "turn_completed",
      ],
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("GatewayBrowserClient.request resolves describe_server", async () => {
  const router = new SessionRouter({
    createSession: async () => fakeSession("s-1", []),
  });
  const server = await startGatewayServer({
    gateway: new InProcessGateway(router, { uuid: () => "run-1" }),
    port: 0,
    token: "describe-token",
  });
  const client = new GatewayBrowserClient({
    url: server.wsUrl,
    token: server.token,
    clientName: "test",
  });
  try {
    await client.connect();
    const info = await client.describeServer();
    assert.equal(info.mode, "in_process");
  } finally {
    client.close();
    await server.close();
  }
});

test("GatewayBrowserClient does not double-render synthetic final turn_completed", async () => {
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession("s-1", [
        { type: "turn_started", sessionId: "s-1", turnId: "run-1" },
        {
          type: "model_event",
          sessionId: "s-1",
          turnId: "run-1",
          event: { type: "text_delta", text: "x" },
        },
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
  const server = await startGatewayServer({
    gateway: new InProcessGateway(router, { uuid: () => "run-1" }),
    port: 0,
    token: "tt",
  });
  const client = new GatewayBrowserClient({
    url: server.wsUrl,
    token: server.token,
    clientName: "test",
  });
  try {
    await client.connect();
    const events = await collect(
      client.submitTurn({ sessionKey: "s-1", channelKey: "web", message: "x", runId: "run-1" }),
    );
    const completedCount = events.filter((event) => event.type === "turn_completed").length;
    assert.equal(completedCount, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test("GatewayBrowserClient rejects when token is wrong", async () => {
  const router = new SessionRouter({
    createSession: async () => fakeSession("s-1", []),
  });
  const server = await startGatewayServer({
    gateway: new InProcessGateway(router, { uuid: () => "run-1" }),
    port: 0,
    token: "real-token",
  });
  const client = new GatewayBrowserClient({
    url: server.wsUrl,
    token: "wrong-token",
    clientName: "test",
    helloTimeoutMs: 1000,
  });
  try {
    await assert.rejects(client.connect());
  } finally {
    client.close();
    await server.close();
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
