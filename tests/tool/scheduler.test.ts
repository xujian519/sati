import test from "node:test";
import assert from "node:assert/strict";
import { SequentialToolScheduler } from "../../src/tool/index.js";
import { createPolitDeckTestTool, createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("executes tool calls sequentially and preserves result order", async () => {
  const seen: string[] = [];
  const first = createPolitDeckTestTool({
    name: "first",
    execute: async () => {
      seen.push("first");
      return { content: [{ type: "text", text: "first" }] };
    },
  });
  const second = createPolitDeckTestTool({
    name: "second",
    execute: async () => {
      seen.push("second");
      return { content: [{ type: "text", text: "second" }] };
    },
  });
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({ tools: [first, second] });
  const scheduler = new SequentialToolScheduler(toolRuntime);

  const results = await scheduler.executeAll(
    [
      { id: "call-1", name: "first", input: {} },
      { id: "call-2", name: "second", input: {} },
    ],
    context,
  );

  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(
    results.map((result) => result.toolCallId),
    ["call-1", "call-2"],
  );
});

test("continues after an earlier tool returns an error", async () => {
  const ok = createPolitDeckTestTool({ name: "ok" });
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({ tools: [ok] });
  const scheduler = new SequentialToolScheduler(toolRuntime);

  const results = await scheduler.executeAll(
    [
      { id: "call-1", name: "missing", input: {} },
      { id: "call-2", name: "ok", input: {} },
    ],
    context,
  );

  assert.equal(results[0]?.type, "error");
  assert.equal(results[1]?.type, "success");
});
