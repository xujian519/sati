import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";

test("classifies anthropic prompt-too-long via case-insensitive substring", () => {
  const error = normalizeModelError("anthropic-main", "anthropic", new Error(
    "messages.0: Prompt is too long: 250000 tokens > 200000 maximum",
  ));
  assert.equal(error.code, "prompt_too_long");
  assert.equal(error.recoverableViaCompact, true);
});

test("classifies anthropic vertex 413 prompt-too-long", () => {
  const error = normalizeModelError("vertex-anthropic", "anthropic", { error: { message: "Prompt is too long" } }, 413);
  assert.equal(error.code, "prompt_too_long");
  assert.equal(error.recoverableViaCompact, true);
});

test("classifies openai context-limit prompt-too-long", () => {
  const error = normalizeModelError("openai-main", "openai", new Error(
    "Bad Request: input length and max_tokens exceed context limit: 100000 < 130000",
  ));
  assert.equal(error.code, "prompt_too_long");
  assert.equal(error.recoverableViaCompact, true);
});

test("classifies request-too-large separately from prompt-too-long", () => {
  const error = normalizeModelError("anthropic-main", "anthropic", new Error("Request too large"));
  assert.equal(error.code, "request_too_large");
  assert.equal(error.recoverableViaCompact, undefined);
});

test("classifies max output reached", () => {
  const error = normalizeModelError("openai-main", "openai", new Error("Maximum output tokens reached"));
  assert.equal(error.code, "max_output_reached");
  assert.equal(error.recoverableViaCompact, undefined);
});

test("falls back to provider error code when no semantic match", () => {
  const error = normalizeModelError(
    "openai-main",
    "openai",
    { error: { code: "rate_limit_exceeded", message: "rate limit" } },
    429,
  );
  assert.equal(error.code, "rate_limit_exceeded");
  assert.equal(error.retryable, true);
});

test("retains 413 with no PTL phrase as request_too_large", () => {
  const error = normalizeModelError("anthropic-main", "anthropic", new Error("Payload too large"), 413);
  assert.equal(error.code, "request_too_large");
});
