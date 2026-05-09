import test from "node:test";
import assert from "node:assert/strict";
import {
  SnipEngine,
  createSnipBoundary,
  isSnipBoundaryMessage,
  projectSnippedView,
} from "../../src/context/compaction/SnipEngine.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function turn(i: number, withToolCall = false): CanonicalMessage[] {
  const ms: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: `q${i}` }] },
  ];
  if (withToolCall) {
    ms.push({
      role: "assistant",
      content: [{ type: "tool_call", id: `t${i}`, name: "read_file", input: {} }],
    });
    ms.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: `t${i}`,
          content: [{ type: "text", text: `r${i}` }],
        },
      ],
    });
  }
  ms.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
  return ms;
}

test("A5.S3 no-op when total turns ≤ keepHead + keepTail", () => {
  const e = new SnipEngine();
  const messages = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
  const r = e.snip(messages);
  assert.equal(r.applied, false);
  assert.equal(r.turnsSnipped, 0);
});

test("A5.S2 default keep 2 head + 4 tail with 10 turns → snip 4 turns in middle", () => {
  const e = new SnipEngine();
  const messages: CanonicalMessage[] = [];
  for (let i = 1; i <= 10; i++) messages.push(...turn(i));
  const r = e.snip(messages);
  assert.equal(r.applied, true);
  assert.equal(r.turnsSnipped, 4);
  // boundary present
  const boundary = r.messages.find(isSnipBoundaryMessage);
  assert.ok(boundary, "expected a snip boundary");
});

test("A5.S5 boundary marker structure", () => {
  const m = createSnipBoundary(3, 2, 4);
  assert.equal(isSnipBoundaryMessage(m), true);
  assert.match(
    (m.content[0] as { text: string }).text,
    /turnsSnipped="3" headTurns="2" tailTurns="4"/,
  );
});

test("A5.S4 dangling tool_call in head whose tool_result was snipped is removed", () => {
  // Layout: 7 turns. First turn has a tool_call. Tail (last 4) does NOT
  // contain its tool_result since turn 1 is in head. Head keeps turn 1+2.
  // Middle snipped (3,4,5,6,7? no — keep head 2 + tail 4 → snip middle 1).
  // We want: head turn-1's tool_call has no matching result in tail → strip.
  const e = new SnipEngine({ keepHeadTurns: 2, keepTailTurns: 4 });
  const head = [...turn(1, true), ...turn(2)];
  const middle = [...turn(3), ...turn(4)];
  const tail = [...turn(5), ...turn(6), ...turn(7), ...turn(8)];
  const r = e.snip([...head, ...middle, ...tail]);
  assert.equal(r.applied, true);
  // tool_call id "t1" should be flagged dangling.
  assert.ok(r.danglingToolCallIds.includes("t1"), "expected t1 dangling");
  // After stripping, no message in result should contain a tool_call with id t1.
  const hasOrphan = r.messages.some((m) =>
    m.content.some((b) => b.type === "tool_call" && b.id === "t1"),
  );
  assert.equal(hasOrphan, false);
});

test("A5.S6 projectSnippedView returns input unchanged when below threshold", () => {
  const messages = [...turn(1), ...turn(2)];
  const projected = projectSnippedView(messages);
  assert.deepEqual(projected, messages);
});

test("A5.S7 disabled engine returns input unchanged", () => {
  const e = new SnipEngine({ enabled: false });
  const messages: CanonicalMessage[] = [];
  for (let i = 1; i <= 10; i++) messages.push(...turn(i));
  const r = e.snip(messages);
  assert.equal(r.applied, false);
  assert.equal(r.messages.length, messages.length);
});

test("A5 turn boundary detection: tool_result-only user msgs do NOT start new turns", () => {
  const e = new SnipEngine({ keepHeadTurns: 1, keepTailTurns: 1 });
  // 3 turns, middle has tool_result-only user msg embedded.
  const messages = [
    ...turn(1, true),
    ...turn(2, true),
    ...turn(3, true),
  ];
  const r = e.snip(messages);
  // 3 turns: 1 head + 1 tail = 2; snip 1.
  assert.equal(r.applied, true);
  assert.equal(r.turnsSnipped, 1);
});
