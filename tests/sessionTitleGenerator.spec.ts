import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionTitleGenerator,
  normalizeSessionTitleInput,
} from "../src/session/title/SessionTitleGenerator.js";
import type { CanonicalModelRequest, CanonicalModelResponse } from "../src/model/index.js";

test("session title generator uses the main agent model and extracts plain JSON title", async () => {
  let capturedRequest: CanonicalModelRequest | undefined;
  const generator = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "openai", model: "gpt-main" },
    modelRuntime: {
      async complete(request) {
        capturedRequest = request;
        return textResponse(JSON.stringify({ title: "Fix login flow" }));
      },
    },
    timeoutMs: 10_000,
  });

  const title = await generator({
    text: "Please fix the broken login flow.",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "Fix login flow");
  assert.equal(capturedRequest?.provider, "openai");
  assert.equal(capturedRequest?.model, "gpt-main");
  assert.equal(capturedRequest?.maxOutputTokens, 1000);
  assert.equal(capturedRequest?.temperature, 0);
  assert.equal(capturedRequest?.outputSchema, undefined);
  assert.equal(capturedRequest?.tools, undefined);
  assert.equal(capturedRequest?.toolChoice, undefined);
});

test("session title generator accepts fenced JSON text", async () => {
  const generator = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "openai", model: "gpt-main" },
    modelRuntime: {
      async complete() {
        return textResponse("```json\n{\"title\":\"Debug failing CI tests\"}\n```");
      },
    },
    timeoutMs: 10_000,
  });

  const title = await generator({
    text: "CI is failing after the dependency update.",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "Debug failing CI tests");
});

test("session title generator returns null for invalid, empty, no-text, or failed responses", async () => {
  const invalid = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "anthropic", model: "claude-main" },
    modelRuntime: {
      async complete() {
        return textResponse("not json");
      },
    },
    timeoutMs: 10_000,
  });
  assert.equal(await invalid({
    text: "hello",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  }), null);

  const empty = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "anthropic", model: "claude-main" },
    modelRuntime: {
      async complete() {
        return textResponse(JSON.stringify({ title: "   " }));
      },
    },
    timeoutMs: 10_000,
  });
  assert.equal(await empty({
    text: "hello",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  }), null);

  const noText = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "anthropic", model: "claude-main" },
    modelRuntime: {
      async complete() {
        return {
          role: "assistant",
          content: [],
          finishReason: "stop",
          usage: {},
        };
      },
    },
    timeoutMs: 10_000,
  });
  assert.equal(await noText({
    text: "hello",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  }), null);

  const failed = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "anthropic", model: "claude-main" },
    modelRuntime: {
      async complete() {
        throw new Error("boom");
      },
    },
    timeoutMs: 10_000,
  });
  assert.equal(await failed({
    text: "hello",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  }), null);
});

test("normalizeSessionTitleInput folds whitespace and caps length", () => {
  assert.equal(normalizeSessionTitleInput("  hello\n\nworld\t "), "hello world");
  assert.equal(normalizeSessionTitleInput("   "), null);
  assert.equal(normalizeSessionTitleInput("x".repeat(1300))?.length, 1200);
});

test("session title generator normalizes and truncates long titles", async () => {
  const generator = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "openai", model: "gpt-main" },
    modelRuntime: {
      async complete() {
        return textResponse(JSON.stringify({ title: `  ${"x ".repeat(100)} ` }));
      },
    },
    timeoutMs: 10_000,
  });

  const title = await generator({
    text: "hello",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title?.length, 80);
  assert.equal(title?.includes("\n"), false);
});

function textResponse(text: string): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: {},
  };
}
