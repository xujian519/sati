import assert from "node:assert/strict";
import test from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type {
  MemoryCaptureTurnInput,
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
} from "../../src/context/memory/MemoryResolver.js";

class RecordingMemoryResolver implements MemoryResolver {
  readonly captures: MemoryCaptureTurnInput[] = [];

  async retrieve(_input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    return { diagnostics: [] };
  }

  async captureTurn(input: MemoryCaptureTurnInput): Promise<void> {
    this.captures.push(input);
  }
}

const ALWAYS_ON_SESSION_IDS = [
  "always-on/discovery:project=/tmp/project:run=run-1",
  "always-on/workspace:project=/tmp/project:run=run-1",
  "always-on/execute:project=/tmp/project:run=run-1",
  "always-on/report:project=/tmp/project:run=run-1",
  "always-on/apply:project=/tmp/project:run=run-1",
];

test("captureTurn skips all Always-On session phases", async () => {
  const memory = new RecordingMemoryResolver();
  const runtime = new DefaultContextRuntime({ memoryResolver: memory });

  for (const sessionId of ALWAYS_ON_SESSION_IDS) {
    await runtime.captureTurn({
      sessionId,
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "internal" }] }],
      errored: false,
    });
  }

  assert.equal(memory.captures.length, 0);
});

test("captureTurn still captures ordinary sessions", async () => {
  const memory = new RecordingMemoryResolver();
  const runtime = new DefaultContextRuntime({ memoryResolver: memory });

  await runtime.captureTurn({
    sessionId: "web:project=/tmp/project:session=1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "remember this" }] }],
    errored: false,
  });

  assert.equal(memory.captures.length, 1);
  assert.equal(memory.captures[0]?.sessionId, "web:project=/tmp/project:session=1");
});
