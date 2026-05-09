import test from "node:test";
import assert from "node:assert/strict";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "../../src/router/retry/zeroUsageRetry.js";

test("shouldRetryZeroUsage retries when finish observed without text and zero usage", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, { type: "message_start", role: "assistant" });
  observeEventForZeroUsage(state, { type: "message_end", finishReason: "stop" });
  observeEventForZeroUsage(state, { type: "usage", usage: { totalTokens: 0 } });
  assert.equal(shouldRetryZeroUsage(state), true);
});

test("shouldRetryZeroUsage does not retry once any text was produced", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, { type: "text_delta", text: "hi" });
  observeEventForZeroUsage(state, { type: "message_end", finishReason: "stop" });
  assert.equal(shouldRetryZeroUsage(state), false);
});

test("shouldRetryZeroUsage does not retry when error event surfaced", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, {
    type: "error",
    error: {
      provider: "p",
      protocol: "anthropic",
      code: "server_error",
      message: "boom",
      retryable: true,
    },
  });
  assert.equal(shouldRetryZeroUsage(state), false);
});

test("shouldRetryZeroUsage does not retry when usage shows positive output tokens", () => {
  const state = createZeroUsageState();
  observeEventForZeroUsage(state, { type: "message_end", finishReason: "stop" });
  observeEventForZeroUsage(state, { type: "usage", usage: { outputTokens: 5 } });
  assert.equal(shouldRetryZeroUsage(state), false);
});
