import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { CliChannel } from "../../../src/adapters/channel/cli/CliChannel.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../../src/gateway/index.js";

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

test("cli prompt submissions disable user prompts", async () => {
  const submitted: GatewaySubmitTurnInput[] = [];
  const gateway = {
    submitTurn: async function* (input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      submitted.push(input);
      yield { type: "turn_completed", usage: {}, finishReason: "stop" };
    },
  } as Gateway;

  const output = new MemoryWritable();
  await new CliChannel({
    argv: ["summarize", "this"],
    projectKey: "/tmp/project",
    output,
    error: new MemoryWritable(),
    probe: false,
  }).start({ gateway });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.message, "summarize this");
  assert.equal(submitted[0]?.canPrompt, false);
});
