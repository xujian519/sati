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

test("SessionRouter lazily recreates dirty sessions on the next getOrCreate", async () => {
  const created: string[] = [];
  const recreated: string[] = [];
  const router = new SessionRouter({
    createSession: async ({ sessionKey }) => {
      created.push(sessionKey);
      return fakeSession(`initial:${sessionKey}`);
    },
    recreateSession: async ({ sessionKey }, previousSession) => {
      recreated.push(`${sessionKey}:${previousSession.snapshot().sessionId}`);
      return fakeSession(`reloaded:${sessionKey}`);
    },
  });

  const first = await router.getOrCreate({ sessionKey: "session-1", projectKey: "/repo/a", channelKey: "cli" });
  router.markProjectDirty("/repo/a", "config_changed");
  const second = await router.getOrCreate({ sessionKey: "session-1", projectKey: "/repo/a", channelKey: "cli" });

  assert.notEqual(first, second);
  assert.equal(second.snapshot().sessionId, "reloaded:session-1");
  assert.deepEqual(created, ["session-1"]);
  assert.deepEqual(recreated, ["session-1:initial:session-1"]);
});

test("SessionRouter keeps the current cached object until a later getOrCreate triggers recreation", async () => {
  const recreated: string[] = [];
  const router = new SessionRouter({
    createSession: async ({ sessionKey }) => fakeSession(`initial:${sessionKey}`),
    recreateSession: async ({ sessionKey }) => {
      recreated.push(sessionKey);
      return fakeSession(`reloaded:${sessionKey}`);
    },
  });

  const first = await router.getOrCreate({ sessionKey: "session-1", projectKey: "/repo/a", channelKey: "cli" });
  assert.equal(router.beginTurn("session-1", "run-1"), true);
  router.markProjectDirty("/repo/a", "extension_changed");
  assert.deepEqual(recreated, []);

  router.endTurn("session-1", "run-1");
  const afterTurn = await router.getOrCreate({ sessionKey: "session-1", projectKey: "/repo/a", channelKey: "cli" });

  assert.notEqual(afterTurn, first);
  assert.deepEqual(recreated, ["session-1"]);
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
