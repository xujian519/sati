import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InProcessGateway,
  SessionRouter,
} from "../../src/gateway/index.js";
import type { AgentEvent, AgentSession } from "../../src/agent/index.js";
import { readPermissionSettings, writePermissionSettings } from "../../src/permission/index.js";

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

test("grantSessionPermission adds a non-persistent allow for only that session", async () => {
  const previousPilotHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = mkdtempSync(join(tmpdir(), "pilotdeck-permissions-"));

  try {
    writePermissionSettings({
      allowedTools: [],
      disallowedTools: ["bash:pwd:*"],
      skipPermissions: true,
    });

    const submitOptionsBySession = new Map<string, any>();
    const router = new SessionRouter({
      createSession: async (context) =>
        fakeSession(context.sessionKey, [], (_input, options) => {
          submitOptionsBySession.set(context.sessionKey, options);
        }),
    });
    const gateway = new InProcessGateway(router, { uuid: () => "run-1" });

    assert.deepEqual(await gateway.grantSessionPermission({
      sessionKey: "session-a",
      entry: "bash:pwd:*",
    }), {
      granted: true,
      entry: "bash:pwd:*",
    });

    for await (const _ of gateway.submitTurn({
      sessionKey: "session-a",
      channelKey: "web",
      message: "pwd",
    })) {
      // drain
    }
    for await (const _ of gateway.submitTurn({
      sessionKey: "session-b",
      channelKey: "web",
      message: "pwd",
    })) {
      // drain
    }

    const sessionAAllow = submitOptionsBySession.get("session-a")?.permissionRules?.allow ?? [];
    assert.deepEqual(sessionAAllow[0], {
      source: "session",
      behavior: "allow",
      toolName: "bash",
      pattern: "pwd:*",
    });

    const sessionBAllow = submitOptionsBySession.get("session-b")?.permissionRules?.allow ?? [];
    assert.equal(sessionBAllow.some((rule: any) => rule.source === "session"), false);

    const persisted = readPermissionSettings();
    assert.deepEqual(persisted.allowedTools, []);
    assert.deepEqual(persisted.disallowedTools, ["bash:pwd:*"]);
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
  }
});

function fakeSession(
  sessionId: string,
  events: AgentEvent[],
  onSubmit?: (input: unknown, options: unknown) => void,
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
    submit: async function* (input: unknown, options: unknown) {
      onSubmit?.(input, options);
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as AgentSession;
}
