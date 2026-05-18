import test from "node:test";
import assert from "node:assert/strict";
import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  buildChildMessage,
  buildForkedMessages,
} from "../../../src/agent/sub/index.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

const parentAssistant: CanonicalMessage = {
  role: "assistant",
  content: [
    { type: "thinking", text: "internal reasoning" },
    {
      type: "tool_call",
      id: "call_1",
      name: "search",
      input: { q: "x" },
    },
    {
      type: "tool_call",
      id: "call_2",
      name: "read_file",
      input: { path: "/a" },
    },
    { type: "text", text: "I will research this." },
  ],
};

test("C2.S1 buildForkedMessages preserves parent assistant message verbatim", () => {
  const out = buildForkedMessages("explain me X", parentAssistant);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "assistant");
  assert.deepEqual(out[0].content, parentAssistant.content);
  // Confirm fresh array (no aliasing of the original message).
  assert.notEqual(out[0], parentAssistant);
});

test("C2.S2 every parent tool_call gets a placeholder tool_result with constant string", () => {
  const out = buildForkedMessages("d", parentAssistant);
  const userMsg = out[1];
  const toolResultBlocks = userMsg.content.filter((b) => b.type === "tool_result");
  assert.equal(toolResultBlocks.length, 2);
  for (const block of toolResultBlocks) {
    assert.equal(block.type, "tool_result");
    if (block.type !== "tool_result") return;
    assert.equal(block.content.length, 1);
    assert.equal(block.content[0].type, "text");
    assert.equal(block.content[0].text, FORK_PLACEHOLDER_RESULT);
  }
  const ids = toolResultBlocks.map((b) =>
    b.type === "tool_result" ? b.toolCallId : "",
  );
  assert.deepEqual(ids, ["call_1", "call_2"]);
});

test("C2.S2 byte-stable fork placeholder enables prompt-cache hit", () => {
  // Two independent forks must produce identical placeholder bytes.
  const a = buildForkedMessages("d1", parentAssistant);
  const b = buildForkedMessages("d2", parentAssistant);
  const aBlock = a[1].content.find((x) => x.type === "tool_result");
  const bBlock = b[1].content.find((x) => x.type === "tool_result");
  assert.ok(aBlock && bBlock);
  if (aBlock?.type !== "tool_result" || bBlock?.type !== "tool_result") return;
  assert.equal(aBlock.content[0].type, "text");
  assert.equal(bBlock.content[0].type, "text");
  assert.equal(aBlock.content[0].text, bBlock.content[0].text);
});

test("C2.S3 buildChildMessage wraps directive in slim fork shell (rules live in system prompt)", () => {
  const text = buildChildMessage("Find usage of foo");
  assert.match(text, new RegExp(`^<${FORK_BOILERPLATE_TAG}>`));
  assert.match(text, new RegExp(`</${FORK_BOILERPLATE_TAG}>$`));
  assert.match(text, /^Directive:\n/m);
  assert.match(text, /Find usage of foo/);
});

test("C2.S3 directive trailing whitespace trimmed but text otherwise preserved", () => {
  const text = buildChildMessage("  do thing\n  ");
  assert.match(text, /Directive:\ndo thing\n<\/pilotdeck-fork>$/);
});

test("C2 throws on non-assistant input", () => {
  assert.throws(() =>
    buildForkedMessages("d", { role: "user", content: [{ type: "text", text: "x" }] } as never),
  );
});
