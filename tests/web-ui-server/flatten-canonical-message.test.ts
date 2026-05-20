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

test("flattens user text and images into one text WebMessage", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      { type: "text", text: "please inspect this" },
      { type: "image", source: "base64", mimeType: "image/png", data: "abc123", bytes: 6 },
    ],
  };

  const out = flattenCanonicalMessage(message, ctx);

  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].kind, "text");
  assert.equal(out[0].text, "please inspect this");
  assert.deepEqual(out[0].images, [
    { data: "data:image/png;base64,abc123", mimeType: "image/png" },
  ]);
});

test("flattens image-only user messages so history can render the bubble", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      { type: "image", source: "base64", mimeType: "image/jpeg", data: "xyz" },
    ],
  };

  const out = flattenCanonicalMessage(message, ctx);

  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].kind, "text");
  assert.equal(out[0].text, "");
  assert.deepEqual(out[0].images, [
    { data: "data:image/jpeg;base64,xyz", mimeType: "image/jpeg" },
  ]);
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

test("tool_result followed by image attaches images to the tool_result, not a user bubble", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "tc-3",
        content: [
          { type: "text", text: "[Image file rendered.]" },
          { type: "image", source: "base64", mimeType: "image/png", data: "img-bytes" },
        ],
      },
      // `projectToolResults` also emits the image as a sibling block so the
      // model gets the picture in its user message.
      { type: "image", source: "base64", mimeType: "image/png", data: "img-bytes", bytes: 9 },
    ],
  };

  const out = flattenCanonicalMessage(message, ctx);

  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "tool_result");
  assert.equal(out[0].role, "tool");
  assert.deepEqual(out[0].images, [
    { data: "data:image/png;base64,img-bytes", mimeType: "image/png" },
  ]);
});

test("multiple tool_result blocks each receive their own image siblings", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "tc-a",
        content: [{ type: "text", text: "first" }],
      },
      { type: "image", source: "base64", mimeType: "image/png", data: "first-img" },
      {
        type: "tool_result",
        toolCallId: "tc-b",
        content: [{ type: "text", text: "second" }],
      },
      { type: "image", source: "base64", mimeType: "image/jpeg", data: "second-img" },
      { type: "image", source: "base64", mimeType: "image/jpeg", data: "second-img-2" },
    ],
  };

  const out = flattenCanonicalMessage(message, ctx);

  assert.equal(out.length, 2);
  assert.equal(out[0].toolCallId, "tc-a");
  assert.deepEqual(out[0].images, [
    { data: "data:image/png;base64,first-img", mimeType: "image/png" },
  ]);
  assert.equal(out[1].toolCallId, "tc-b");
  assert.deepEqual(out[1].images, [
    { data: "data:image/jpeg;base64,second-img", mimeType: "image/jpeg" },
    { data: "data:image/jpeg;base64,second-img-2", mimeType: "image/jpeg" },
  ]);
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
