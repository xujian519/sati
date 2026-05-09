import test from "node:test";
import assert from "node:assert/strict";
import { flattenCanonicalMessage } from "../../src/web/server/readSessionMessages.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const ctx = {
  index: 0,
  sessionKey: "web:test",
  projectKey: "demo",
  now: () => new Date("2026-05-09T00:00:00.000Z"),
};

test("flattens an assistant text-only message into a single text WebMessage", () => {
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ],
  };
  const out = flattenCanonicalMessage(message, ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "assistant");
  assert.equal(out[0].kind, "text");
  assert.equal(out[0].text, "hello world");
  assert.equal(out[0].source, "history");
});

test("splits assistant text + tool_call into two WebMessages preserving order", () => {
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "running tool" },
      { type: "tool_call", id: "tc-1", name: "Read", input: { path: "a" } },
    ],
  };
  const out = flattenCanonicalMessage(message, ctx);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "text");
  assert.equal(out[1].kind, "tool_use");
  assert.equal(out[1].toolCallId, "tc-1");
  assert.equal(out[1].toolName, "Read");
});

test("user tool_result message becomes a tool result WebMessage", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "tc-1",
        content: [{ type: "text", text: "ok" }],
      },
    ],
  };
  const out = flattenCanonicalMessage(message, ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "tool_result");
  assert.equal(out[0].ok, true);
  assert.equal(out[0].text, "ok");
});

test("isError tool_result yields ok=false", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "tc-2",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
    ],
  };
  const out = flattenCanonicalMessage(message, ctx);
  assert.equal(out[0].ok, false);
});

test("thinking block is preserved as a separate assistant thinking message", () => {
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      { type: "thinking", text: "hmm..." },
      { type: "text", text: "answer" },
    ],
  };
  const out = flattenCanonicalMessage(message, ctx);
  assert.deepEqual(out.map((m) => m.kind), ["thinking", "text"]);
});
