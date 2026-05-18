import test from "node:test";
import assert from "node:assert/strict";
import { InProcessGateway, SessionRouter, mapAgentEvent } from "../../src/gateway/index.js";
import type { AgentEvent, AgentInput, AgentSession } from "../../src/agent/index.js";

test("InProcessGateway maps a text turn to GatewayEvent stream", async () => {
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession("session-1", [
        { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
        {
          type: "model_event",
          sessionId: "session-1",
          turnId: "run-1",
          event: { type: "text_delta", text: "Hello" },
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
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      ]),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });

  const events = await collect(
    gateway.submitTurn({
      sessionKey: "cli:project=one:default",
      channelKey: "cli",
      message: "hi",
    }),
  );

  assert.deepEqual(events, [
    { type: "turn_started", runId: "run-1" },
    { type: "assistant_text_delta", text: "Hello" },
    { type: "turn_completed", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "completed" },
  ]);
});

test("InProcessGateway rejects a busy session", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = new SessionRouter({
    createSession: async () =>
      ({
        abort: () => undefined,
        snapshot: () => ({
          sessionId: "session-1",
          messages: [],
          usage: {},
          permissionDenials: [],
          status: "idle",
          abortController: new AbortController(),
        }),
        replay: async function* () {},
        submit: async function* () {
          yield { type: "turn_started", sessionId: "session-1", turnId: "run-1" } satisfies AgentEvent;
          await blocker;
        },
      }) as unknown as AgentSession,
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
  const first = gateway.submitTurn({ sessionKey: "session-1", channelKey: "cli", message: "one", runId: "run-1" });

  const iterator = first[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { type: "turn_started", runId: "run-1" } });

  const busyEvents = await collect(
    gateway.submitTurn({ sessionKey: "session-1", channelKey: "cli", message: "two", runId: "run-2" }),
  );
  assert.deepEqual(busyEvents, [
    {
      type: "error",
      code: "session_busy",
      message: "Session session-1 already has an active turn.",
      recoverable: true,
    },
  ]);

  release();
  await iterator.next();
});

test("InProcessGateway.abortTurn waits for the in-flight turn to fully unwind", async () => {
  // Regression for the "Session ... already has an active turn." race:
  // before this fix, abort_turn returned as soon as router.abort() had
  // notified the agent session, but inFlightTurns was only cleared in
  // submitTurn's finally — so a client that called `submit -> abort ->
  // submit` on a hot WS connection could race the cleanup and see
  // `session_busy` on the resubmit. The contract is now: when abortTurn
  // resolves, a fresh submitTurn for the same session is accepted.
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = new SessionRouter({
    createSession: async () =>
      ({
        abort: () => release(),
        snapshot: () => ({
          sessionId: "session-1",
          messages: [],
          usage: {},
          permissionDenials: [],
          status: "idle",
          abortController: new AbortController(),
        }),
        replay: async function* () {},
        submit: async function* () {
          yield { type: "turn_started", sessionId: "session-1", turnId: "run-1" } satisfies AgentEvent;
          await blocker;
        },
      }) as unknown as AgentSession,
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-2" });

  const first = gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "cli",
    message: "one",
    runId: "run-1",
  });
  const firstDrain = (async () => {
    for await (const _event of first) {
      void _event;
    }
  })();
  // Yield once so the consumer's pump installs the inFlight slot and
  // turn-completion deferred before we abort.
  await new Promise((r) => setImmediate(r));

  await gateway.abortTurn({ sessionKey: "session-1", runId: "run-1" });

  const secondEvents = await collect(
    gateway.submitTurn({
      sessionKey: "session-1",
      channelKey: "cli",
      message: "two",
      runId: "run-2",
    }),
  );
  assert.equal(
    secondEvents.some((e) => e.type === "error" && e.code === "session_busy"),
    false,
    "second submit must not be rejected as busy",
  );

  await firstDrain;
});

test("InProcessGateway exposes replayable active turn snapshot while a turn is streaming", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = new SessionRouter({
    createSession: async () =>
      ({
        abort: () => release(),
        snapshot: () => ({
          sessionId: "session-1",
          messages: [],
          usage: {},
          permissionDenials: [],
          status: "idle",
          abortController: new AbortController(),
        }),
        replay: async function* () {},
        submit: async function* () {
          yield { type: "turn_started", sessionId: "session-1", turnId: "run-1" } satisfies AgentEvent;
          yield {
            type: "model_event",
            sessionId: "session-1",
            turnId: "run-1",
            event: { type: "text_delta", text: "partial" },
          } satisfies AgentEvent;
          await blocker;
          yield {
            type: "turn_completed",
            sessionId: "session-1",
            turnId: "run-1",
            result: {
              type: "success",
              sessionId: "session-1",
              turnId: "run-1",
              stopReason: "completed",
              usage: { totalTokens: 1 },
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:01.000Z",
            },
          } satisfies AgentEvent;
        },
      }) as unknown as AgentSession,
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
  const iterator = gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "web",
    message: "one",
    runId: "run-1",
  })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { done: false, value: { type: "turn_started", runId: "run-1" } });
  assert.deepEqual(await iterator.next(), { done: false, value: { type: "assistant_text_delta", text: "partial" } });

  const active = await gateway.getActiveTurnSnapshot({ sessionKey: "session-1" });
  assert.equal(active.active, true);
  assert.equal(active.runId, "run-1");
  assert.deepEqual(active.events, [
    { type: "turn_started", runId: "run-1" },
    { type: "assistant_text_delta", text: "partial" },
  ]);

  release();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "turn_completed", usage: { totalTokens: 1 }, finishReason: "completed" },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });

  const inactive = await gateway.getActiveTurnSnapshot({ sessionKey: "session-1" });
  assert.deepEqual(inactive, { active: false, sessionKey: "session-1", events: [] });
});

test("mapAgentEvent does not surface transient model errors before turn_failed", () => {
  const frames = mapAgentEvent({
    type: "model_event",
    sessionId: "session-1",
    turnId: "run-1",
    event: {
      type: "error",
      error: {
        provider: "p",
        protocol: "openai",
        code: "provider_error",
        message: "Provider returned error",
        retryable: true,
      },
    },
  }, "run-1");

  assert.deepEqual(frames, []);
});

test("mapAgentEvent surfaces terminal turn_failed once", () => {
  const frames = mapAgentEvent({
    type: "turn_failed",
    sessionId: "session-1",
    turnId: "run-1",
    error: {
      code: "agent_model_error",
      message: "Provider returned error",
    },
  }, "run-1");

  assert.deepEqual(frames, [
    {
      type: "error",
      code: "agent_model_error",
      message: "Provider returned error",
      recoverable: false,
    },
  ]);
});

test("InProcessGateway fires afterTurnCompleted without blocking turn completion", async () => {
  let releaseMaintenance!: () => void;
  const maintenanceStarted = new Promise<void>((resolve) => {
    releaseMaintenance = resolve;
  });
  const afterTurnCalls: Array<{ sessionKey: string; projectKey?: string; runId: string }> = [];
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession("session-1", [
        { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
        {
          type: "turn_completed",
          sessionId: "session-1",
          turnId: "run-1",
          result: {
            type: "success",
            sessionId: "session-1",
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
  const gateway = new InProcessGateway(router, {
    uuid: () => "run-1",
    afterTurnCompleted: (input) => {
      afterTurnCalls.push(input);
      void maintenanceStarted;
    },
  });

  const events = await collect(
    gateway.submitTurn({
      sessionKey: "cli:project=one:default",
      channelKey: "cli",
      projectKey: "/repo",
      message: "hi",
    }),
  );

  assert.equal(events.at(-1)?.type, "turn_completed");
  assert.deepEqual(afterTurnCalls, [{ sessionKey: "cli:project=one:default", projectKey: "/repo", runId: "run-1" }]);
  releaseMaintenance();
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function fakeSession(
  sessionId: string,
  events: AgentEvent[],
  capturedInputs?: AgentInput[],
): AgentSession {
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
    submit: async function* (input: AgentInput) {
      capturedInputs?.push(input);
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as AgentSession;
}

test("InProcessGateway forwards image attachments as a multimodal blocks input", async () => {
  // Regression for the web-UI image-upload pipeline. The bridge converts
  // UI-shape `{ name, data: 'data:image/png;base64,...' }` into
  // ChannelAttachment[] and forwards via submitTurn. The gateway must
  // promote the text-only turn into a blocks turn carrying the
  // CanonicalImageBlock — otherwise the agent never sees the image even
  // though the attachment travels through the WS frame.
  const capturedInputs: AgentInput[] = [];
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession(
        "session-1",
        [
          { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
          {
            type: "turn_completed",
            sessionId: "session-1",
            turnId: "run-1",
            result: {
              type: "success",
              sessionId: "session-1",
              turnId: "run-1",
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:01.000Z",
            },
          },
        ],
        capturedInputs,
      ),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:project=one:default",
    channelKey: "web",
    message: "Describe this",
    attachments: [
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        content: "iVBORw0KG...",
        bytes: 42,
      },
    ],
  })) {
    // drain
    void _event;
  }

  assert.equal(capturedInputs.length, 1, "submit should be called once");
  const input = capturedInputs[0];
  assert.equal(input.type, "blocks", "input should be promoted to blocks");
  if (input.type !== "blocks") return;
  assert.equal(input.content.length, 2, "expected [text, image] blocks");
  assert.deepEqual(input.content[0], { type: "text", text: "Describe this" });
  assert.deepEqual(input.content[1], {
    type: "image",
    source: "base64",
    data: "iVBORw0KG...",
    mimeType: "image/png",
    bytes: 42,
  });
});

test("InProcessGateway awaits refreshConfigBeforeTurn before beginning a turn", async () => {
  // Defensive hook: when wired, the gateway should re-read on-disk
  // config before each turn so a credential edit applied between two
  // messages takes effect on the very next one — even if the fs
  // watcher missed the change. Order matters: refresh must complete
  // *before* the session is resolved (otherwise it would be operating
  // on the stale snapshot).
  const observedOrder: string[] = [];
  const refreshes: { resolve: () => void }[] = [];
  const router = new SessionRouter({
    createSession: async () => {
      observedOrder.push("createSession");
      return fakeSession("session-1", [
        { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
        {
          type: "turn_completed",
          sessionId: "session-1",
          turnId: "run-1",
          result: {
            type: "success",
            sessionId: "session-1",
            turnId: "run-1",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      ]);
    },
  });
  let refreshCallCount = 0;
  const gateway = new InProcessGateway(router, {
    uuid: () => "run-1",
    refreshConfigBeforeTurn: async () => {
      refreshCallCount += 1;
      observedOrder.push("refresh-start");
      // Force createSession to wait by holding an unresolved promise.
      await new Promise<void>((resolve) => {
        refreshes.push({ resolve });
      });
      observedOrder.push("refresh-end");
    },
  });

  const turn = (async () => {
    for await (const _event of gateway.submitTurn({
      sessionKey: "cli:project=one:default",
      channelKey: "cli",
      message: "hi",
    })) {
      void _event;
    }
  })();

  // Yield to let submitTurn schedule the refresh hook.
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshCallCount, 1, "refresh must run exactly once per turn");
  assert.deepEqual(observedOrder, ["refresh-start"], "createSession must not run while refresh is pending");

  refreshes[0].resolve();
  await turn;

  assert.deepEqual(
    observedOrder,
    ["refresh-start", "refresh-end", "createSession"],
    "createSession must run only after refresh resolves",
  );
});

test("InProcessGateway swallows refreshConfigBeforeTurn errors so chats keep flowing", async () => {
  // Refresh failures (transient yaml read error, fs blip) must not
  // turn into a user-visible turn failure: keep streaming on the
  // previous snapshot and let the next refresh recover.
  let createSessionCalls = 0;
  const router = new SessionRouter({
    createSession: async () => {
      createSessionCalls += 1;
      return fakeSession("session-1", [
        { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
        {
          type: "turn_completed",
          sessionId: "session-1",
          turnId: "run-1",
          result: {
            type: "success",
            sessionId: "session-1",
            turnId: "run-1",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      ]);
    },
  });
  const gateway = new InProcessGateway(router, {
    uuid: () => "run-1",
    refreshConfigBeforeTurn: async () => {
      throw new Error("transient yaml read error");
    },
  });

  const events = await collect(
    gateway.submitTurn({
      sessionKey: "cli:project=one:default",
      channelKey: "cli",
      message: "hi",
    }),
  );

  assert.equal(createSessionCalls, 1, "turn must still proceed after refresh failure");
  assert.equal(events[0].type, "turn_started");
  assert.equal(events[events.length - 1].type, "turn_completed");
});

test("InProcessGateway keeps text-only turns as a plain text input", async () => {
  const capturedInputs: AgentInput[] = [];
  const router = new SessionRouter({
    createSession: async () =>
      fakeSession(
        "session-1",
        [
          { type: "turn_started", sessionId: "session-1", turnId: "run-1" },
          {
            type: "turn_completed",
            sessionId: "session-1",
            turnId: "run-1",
            result: {
              type: "success",
              sessionId: "session-1",
              turnId: "run-1",
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:01.000Z",
            },
          },
        ],
        capturedInputs,
      ),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });

  for await (const _event of gateway.submitTurn({
    sessionKey: "cli:project=one:default",
    channelKey: "cli",
    message: "hi",
  })) {
    void _event;
  }

  assert.deepEqual(capturedInputs, [{ type: "text", text: "hi" }]);
});
