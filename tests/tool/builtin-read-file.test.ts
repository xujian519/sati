import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createReadFileTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("read_file reads text files with offset and limit", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "src/a.txt": "one\ntwo\nthree\nfour" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "src/a.txt", offset: 2, limit: 2 } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "2|two\n3|three");
  assert.equal(result.metadata?.truncated, true);
});

test("read_file returns controlled errors for missing and outside paths", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const missing = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "missing.txt" } },
    context,
  );
  const outside = await toolRuntime.execute(
    { id: "call-2", name: "read_file", input: { file_path: "../outside.txt" } },
    context,
  );

  assert.equal(missing.type, "error");
  assert.equal(outside.type, "error");
  if (missing.type === "error") assert.equal(missing.error.code, "file_not_found");
  if (outside.type === "error") assert.equal(outside.error.code, "path_not_allowed");
});

test("read_file returns unchanged stub for repeated reads", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "src/a.txt": "one\ntwo\nthree" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const first = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "src/a.txt" } },
    context,
  );
  const second = await toolRuntime.execute(
    { id: "call-2", name: "read_file", input: { file_path: "src/a.txt" } },
    context,
  );

  assert.equal(first.type, "success");
  assert.equal(second.type, "success");
  assert.equal(second.content[0]?.type, "text");
  assert.match(
    second.content[0]?.type === "text" ? second.content[0].text : "",
    /File unchanged since the last read/,
  );
  assert.equal(context.writeSnapshots?.get(path.join(workspace.cwd, "src/a.txt"))?.absolutePath, path.join(workspace.cwd, "src/a.txt"));
  assert.equal(context.writeSnapshots?.get(path.join(workspace.cwd, "src/a.txt"))?.mtimeMs !== undefined, true);
});

test("read_file renders notebook files as numbered text", async (t) => {
  const notebook = JSON.stringify({
    cells: [
      {
        cell_type: "markdown",
        source: ["# Title\n", "hello"],
      },
      {
        cell_type: "code",
        execution_count: 1,
        source: ["print('hi')\n"],
        outputs: [{ text: ["hi\n"] }],
      },
    ],
  });
  const workspace = await createPilotDeckTempWorkspace({ "demo.ipynb": notebook });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "demo.ipynb" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "text");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /1\|# Cell 0 \(markdown\)/);
  assert.match(text, /Cell 1 \(code\)/);
});

test("read_file returns image blocks when the model supports images", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2pL7sAAAAASUVORK5CYII=",
    "base64",
  );
  const workspace = await createPilotDeckTempWorkspace({ "pixel.png": png });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    modelMultimodal: { input: ["text", "image"], maxImageBytes: 5_242_880 },
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "pixel.png" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "image");
  if (result.content[0]?.type === "image") {
    assert.equal(result.content[0].mimeType, "image/png");
    assert.ok(result.content[0].data.length > 0);
  }
});

test("read_file returns pdf blocks and validates page ranges", async (t) => {
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n%%EOF\n",
    "utf8",
  );
  const workspace = await createPilotDeckTempWorkspace({ "doc.pdf": pdf });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    modelMultimodal: { input: ["text", "pdf"], maxPdfBytes: 1_000_000, maxPdfPages: 20 },
  });

  const success = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "doc.pdf", pages: "1" } },
    context,
  );
  const invalid = await toolRuntime.execute(
    { id: "call-2", name: "read_file", input: { file_path: "doc.pdf", pages: "2-25" } },
    context,
  );

  assert.equal(success.type, "success");
  assert.equal(success.content[0]?.type, "text");
  assert.ok(success.supplementalMessages);
  assert.equal(success.supplementalMessages![0]!.content[0]?.type, "pdf");
  assert.equal(invalid.type, "error");
  if (invalid.type === "error") {
    assert.equal(invalid.error.code, "invalid_tool_input");
  }
});
