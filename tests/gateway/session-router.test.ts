import test from "node:test";
import assert from "node:assert/strict";
import { SessionRouter } from "../../src/gateway/index.js";
import type { AgentSession } from "../../src/agent/index.js";

test("SessionRouter creates and caches sessions by sessionKey", async () => {
  const created: string[] = [];
  const router = new SessionRouter({
    createSession: async ({ sessionKey }) => {
      created.push(sessionKey);
      return fakeSession(sessionKey);
    },
  });

  const first = await router.getOrCreate({ sessionKey: "cli:project=one:default", channelKey: "cli" });
  const second = await router.getOrCreate({ sessionKey: "cli:project=one:default", channelKey: "cli" });

  assert.equal(first, second);
  assert.deepEqual(created, ["cli:project=one:default"]);
});

test("SessionRouter rejects concurrent turns for the same sessionKey", () => {
  const router = new SessionRouter({
    createSession: async ({ sessionKey }) => fakeSession(sessionKey),
  });

  assert.equal(router.beginTurn("session-1", "run-1"), true);
  assert.equal(router.beginTurn("session-1", "run-2"), false);
  router.endTurn("session-1", "run-1");
  assert.equal(router.beginTurn("session-1", "run-3"), true);
});

test("SessionRouter evicts idle sessions", async () => {
  let now = 0;
  const created: string[] = [];
  const router = new SessionRouter({
    idleSessionTimeoutMs: 10,
    now: () => new Date(now),
    createSession: async ({ sessionKey }) => {
      created.push(sessionKey);
      return fakeSession(sessionKey);
    },
  });

  await router.getOrCreate({ sessionKey: "session-1", channelKey: "cli" });
  now = 11;
  await router.getOrCreate({ sessionKey: "session-1", channelKey: "cli" });

  assert.deepEqual(created, ["session-1", "session-1"]);
});

function fakeSession(sessionId: string): AgentSession {
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
    submit: async function* () {},
  } as unknown as AgentSession;
}
