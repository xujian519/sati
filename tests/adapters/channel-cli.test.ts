import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { CliChannel } from "../../src/adapters/index.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

test("CliChannel submits argv prompt to gateway and renders text", async () => {
  const calls: GatewaySubmitTurnInput[] = [];
  const output = new StringSink();
  const error = new StringSink();
  const channel = new CliChannel({
    argv: ["hello"],
    projectKey: "proj",
    output,
    error,
    probe: false,
  });
  await channel.start({
    gateway: fakeGateway(calls, [
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "world" },
      { type: "turn_completed", usage: {}, finishReason: "completed" },
    ]),
  });

  assert.equal(output.value, "world");
  assert.equal(error.value, "");
  assert.deepEqual(calls, [
    {
      sessionKey: "cli:project=proj:default",
      channelKey: "cli",
      projectKey: "proj",
      message: "hello",
    },
  ]);
});

class StringSink extends Writable {
  value = "";
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

function fakeGateway(calls: GatewaySubmitTurnInput[], events: GatewayEvent[]): Gateway {
  return {
    submitTurn: async function* (input) {
      calls.push(input);
      for (const event of events) {
        yield event;
      }
    },
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async (input) => input,
    newSession: async () => ({ sessionKey: "new" }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" }),
    cronCreate: async () => {
      throw new Error("not configured");
    },
    cronList: async () => {
      throw new Error("not configured");
    },
    cronDelete: async () => {
      throw new Error("not configured");
    },
    cronStop: async () => {
      throw new Error("not configured");
    },
    cronRunNow: async () => {
      throw new Error("not configured");
    },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => {
      throw new Error("not configured");
    },
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  };
}
