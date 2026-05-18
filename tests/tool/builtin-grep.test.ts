import test from "node:test";
import assert from "node:assert/strict";
import { createGrepTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("grep returns files with matches by default", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/a.txt": "Hello\nworld",
    "src/b.txt": "nope",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "hello", "-i": true } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, { mode: "files_with_matches", files: ["src/a.txt"], count: 1, truncated: false });
});

test("grep supports content and count modes", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "a.txt": "alpha\nbeta\nalpha",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const content = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "beta", output_mode: "content", context: 1 } },
    context,
  );
  const count = await toolRuntime.execute(
    { id: "call-2", name: "grep", input: { pattern: "alpha", output_mode: "count" } },
    context,
  );

  assert.equal(content.type, "success");
  assert.match(content.content[0]?.type === "text" ? content.content[0].text : "", /a\.txt:2:beta/);
  assert.equal(count.type, "success");
  assert.deepEqual(count.data, { mode: "count", files: ["a.txt"], count: 2, truncated: false });
});
