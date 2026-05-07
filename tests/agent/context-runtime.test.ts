import test from "node:test";
import assert from "node:assert/strict";
import { NullContextRuntime } from "../../src/agent/context/NullContextRuntime.js";

test("NullContextRuntime can retain only the latest messages", async () => {
  const runtime = new NullContextRuntime({ maxMessages: 2 });
  const prepared = await runtime.prepareForModel({
    messages: [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
    ],
    tools: [{ name: "lookup", inputSchema: { type: "object" } }],
  });

  assert.equal(prepared.messages.length, 2);
  assert.equal(prepared.boundaries[0]?.type, "compact");
  assert.equal(prepared.diagnostics[0]?.code, "context_truncated");
});
