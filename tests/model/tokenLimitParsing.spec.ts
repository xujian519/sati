import test from "node:test";
import assert from "node:assert/strict";
import { parseTokenLimitError } from "../../src/model/index.js";

test("parses DashScope max_tokens range as output cap", () => {
  assert.deepEqual(parseTokenLimitError("Range of max_tokens should be [1, 65536]"), {
    kind: "output",
    maxOutputTokens: 65536,
  });
});

test("parses max_tokens at-most phrasing as output cap", () => {
  assert.deepEqual(parseTokenLimitError("max_tokens must be at most 32768 for this model"), {
    kind: "output",
    maxOutputTokens: 32768,
  });
});

test("parses requested output tokens context error as output recovery", () => {
  assert.deepEqual(
    parseTokenLimitError(
      "This model's maximum context length is 65536 tokens. However, you requested 65536 output tokens and your prompt contains 60000 tokens.",
    ),
    { kind: "output", availableOutputTokens: 5536 },
  );
});

test("parses max_model_len as context cap", () => {
  assert.deepEqual(parseTokenLimitError("Input exceeds the max_model_len of 262144 tokens."), {
    kind: "context",
    maxContextTokens: 262144,
  });
});

test("parses limit-is context errors using the provider limit", () => {
  assert.deepEqual(parseTokenLimitError("context_length_exceeded: prompt has 131073 tokens, limit is 131072 tokens"), {
    kind: "context",
    maxContextTokens: 131072,
  });
});

test("parses max_tokens greater-than context_window as output cap", () => {
  assert.deepEqual(parseTokenLimitError("max_tokens: 65536 > context_window: 32768"), {
    kind: "output",
    maxOutputTokens: 32768,
  });
});
