import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenAIResponse } from "../../src/model/providers/openai/response.js";

test("OpenAI-compatible response parser preserves message.reasoning", () => {
  const parsed = parseOpenAIResponse({
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        reasoning: "provider reasoning text",
      },
      finish_reason: "stop",
    }],
  }, "hxapi");

  assert.deepEqual(parsed.content, [{ type: "thinking", text: "provider reasoning text" }]);
});
