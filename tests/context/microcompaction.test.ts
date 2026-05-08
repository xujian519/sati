import test from "node:test";
import assert from "node:assert/strict";
import { MicroCompactionEngine } from "../../src/context/compaction/MicroCompactionEngine.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function toolResult(id: string, size: number): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text: "x".repeat(size) }] }],
  };
}

test("MicroCompactionEngine rewrites older tool_results, keeps the last one", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 100 });
  const messages: CanonicalMessage[] = [
    toolResult("a", 500),
    toolResult("b", 500),
    toolResult("c", 500),
  ];
  const result = engine.apply({ messages });
  assert.equal(result.appliedTrigger, "time_based");
  assert.equal(result.rewritten, 2);
  assert.deepEqual(result.toolCallIds, ["a", "b"]);
  // last one kept untouched
  const last = result.messages[2]!.content[0] as { content: Array<{ text: string }> };
  assert.equal(last.content[0]?.text.length, 500);
});

test("MicroCompactionEngine returns skipped when only keepLatest results exist", () => {
  const engine = new MicroCompactionEngine({ keepLatest: 1, trimToBytes: 50 });
  const result = engine.apply({ messages: [toolResult("a", 200)] });
  assert.equal(result.appliedTrigger, "skipped");
  assert.equal(result.rewritten, 0);
});
