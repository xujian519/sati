import test from "node:test";
import assert from "node:assert/strict";
import { createGrepTool } from "../../src/tool/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("grep returns files with matches by default", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({
    "src/a.txt": "Hello\nworld",
    "src/b.txt": "nope",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "hello", caseInsensitive: true } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, { mode: "files_with_matches", files: ["src/a.txt"], count: 1, truncated: false });
});

test("grep supports content and count modes", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({
    "a.txt": "alpha\nbeta\nalpha",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const content = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "beta", outputMode: "content", context: 1 } },
    context,
  );
  const count = await toolRuntime.execute(
    { id: "call-2", name: "grep", input: { pattern: "alpha", outputMode: "count" } },
    context,
  );

  assert.equal(content.type, "success");
  assert.match(content.content[0]?.type === "text" ? content.content[0].text : "", /a\.txt:2:beta/);
  assert.equal(count.type, "success");
  assert.deepEqual(count.data, { mode: "count", files: ["a.txt"], count: 2, truncated: false });
});
