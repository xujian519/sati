import assert from "node:assert/strict";
import { utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createGrepTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("grep paginates files_with_matches and sorts newest files first", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/older.txt": "Hello\nworld",
    "src/newer.txt": "Hello\nagain",
  });
  t.after(() => workspace.cleanup());
  const now = new Date();
  await utimes(
    path.join(workspace.cwd, "src/older.txt"),
    new Date(now.getTime() - 60_000),
    new Date(now.getTime() - 60_000),
  );
  await utimes(path.join(workspace.cwd, "src/newer.txt"), now, now);
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "hello", "-i": true, head_limit: 1 } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, {
    mode: "files_with_matches",
    files: ["src/newer.txt"],
    count: 2,
    truncated: true,
  });
});

test("grep content mode supports pagination and hiding line numbers", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "a.txt": "alpha\nbeta\nalpha",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const content = await toolRuntime.execute(
    {
      id: "call-1",
      name: "grep",
      input: {
        pattern: "alpha|beta",
        output_mode: "content",
        "-n": false,
        head_limit: 1,
        offset: 1,
      },
    },
    context,
  );

  assert.equal(content.type, "success");
  assert.equal(content.content[0]?.type, "text");
  assert.equal(content.content[0]?.type === "text" ? content.content[0].text : "", "a.txt:beta");
  assert.deepEqual(content.data, {
    mode: "content",
    files: ["a.txt"],
    count: 3,
    truncated: true,
  });
});

test("grep count mode paginates entries but preserves total match count", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "a.txt": "alpha\nalpha",
    "b.txt": "alpha",
    "c.txt": "nope",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const count = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "alpha", output_mode: "count", head_limit: 1 } },
    context,
  );

  assert.equal(count.type, "success");
  assert.equal(count.content[0]?.type, "text");
  assert.equal(count.content[0]?.type === "text" ? count.content[0].text : "", "a.txt:2");
  assert.deepEqual(count.data, {
    mode: "count",
    files: ["a.txt"],
    count: 3,
    truncated: true,
  });
});

test("grep supports type filters", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "src/a.ts": "const needle = true;",
    "src/a.js": "const needle = true;",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "needle", type: "ts" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, {
    mode: "files_with_matches",
    files: ["src/a.ts"],
    count: 1,
    truncated: false,
  });
});

test("grep supports multiline patterns and dash-prefixed literals", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "multi.txt": "alpha\nbeta\ngamma",
    "flags.txt": "-flag\nother",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });

  const multiline = await toolRuntime.execute(
    {
      id: "call-1",
      name: "grep",
      input: { pattern: "alpha\\nbeta", output_mode: "content", multiline: true },
    },
    context,
  );
  const dashLiteral = await toolRuntime.execute(
    { id: "call-2", name: "grep", input: { pattern: "-flag" } },
    context,
  );

  assert.equal(multiline.type, "success");
  const multilineText =
    multiline.content[0]?.type === "text" ? multiline.content[0].text : "";
  assert.match(multilineText, /alpha/);
  assert.match(multilineText, /beta/);

  assert.equal(dashLiteral.type, "success");
  assert.deepEqual(dashLiteral.data, {
    mode: "files_with_matches",
    files: ["flags.txt"],
    count: 1,
    truncated: false,
  });
});

test("grep reports unsupported_tool when ripgrep is unavailable", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({
    "a.txt": "alpha",
  });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createGrepTool()],
    cwd: workspace.cwd,
  });
  context.env = {
    ...process.env,
    PATH: "",
    Path: "",
  };

  const result = await toolRuntime.execute(
    { id: "call-1", name: "grep", input: { pattern: "alpha" } },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "unsupported_tool");
    assert.match(result.error.message, /ripgrep/i);
  }
});
