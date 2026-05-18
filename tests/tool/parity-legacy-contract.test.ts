import test from "node:test";
import assert from "node:assert/strict";
import {
  createBashTool,
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  ToolRegistry,
} from "../../src/tool/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";

test("PilotDeck tool lookup preserves legacy alias behavior", () => {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());

  assert.equal(registry.get("read_file")?.name, "read_file");
  assert.equal(registry.get("Read")?.name, "read_file");
  assert.equal(registry.get("Write"), undefined);
});

test("PilotDeck permission mode context preserves fallback defaults", () => {
  const context = createDefaultPermissionContext({ cwd: "/tmp", mode: "plan" });
  const fallback = createDefaultPermissionContext({ cwd: "/tmp" });

  assert.equal(context.mode, "plan");
  assert.equal(fallback.mode, "default");
});

test("PilotDeck filesystem read and search tools are read-only and concurrency safe", () => {
  const read = createReadFileTool();
  const glob = createGlobTool();
  const grep = createGrepTool();

  assert.equal(read.name, "read_file");
  assert.equal(read.isReadOnly({ file_path: "package.json" }), true);

  assert.equal(glob.name, "glob");
  assert.equal(glob.isReadOnly({ pattern: "**/*" }), true);
  assert.equal(glob.isConcurrencySafe({ pattern: "**/*" }), true);

  assert.equal(grep.name, "grep");
  assert.equal(grep.isReadOnly({ pattern: "needle" }), true);
  assert.equal(grep.isConcurrencySafe({ pattern: "needle" }), true);
});

test("PilotDeck bash read-only classification drives concurrency safety", () => {
  const bash = createBashTool({
    runner: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
    },
  });

  assert.equal(bash.name, "bash");
  assert.equal(bash.isReadOnly({ command: "pwd" }), true);
  assert.equal(bash.isConcurrencySafe({ command: "pwd" }), true);

  assert.equal(bash.isReadOnly({ command: "npm install" }), false);
  assert.equal(bash.isConcurrencySafe({ command: "npm install" }), false);
});
