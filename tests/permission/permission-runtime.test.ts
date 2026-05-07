import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { createPolitDeckTestTool, createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("default mode allows read-only tools and asks for write tools", async () => {
  const runtime = new PermissionRuntime();
  const readTool = createPolitDeckTestTool({ name: "read_file", readOnly: true });
  const writeTool = createPolitDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPolitDeckToolRuntimeFixture({ permissionMode: "default", canPrompt: true });

  assert.equal((await runtime.decide(readTool, {}, context, "call-1")).type, "allow");
  assert.equal((await runtime.decide(writeTool, {}, context, "call-2")).type, "ask");
});

test("plan mode allows read-only tools and denies side-effecting tools", async () => {
  const runtime = new PermissionRuntime();
  const readTool = createPolitDeckTestTool({ name: "read_file", readOnly: true });
  const writeTool = createPolitDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPolitDeckToolRuntimeFixture({ permissionMode: "plan" });

  assert.equal((await runtime.decide(readTool, {}, context, "call-1")).type, "allow");
  assert.equal((await runtime.decide(writeTool, {}, context, "call-2")).type, "deny");
});

test("acceptEdits allows filesystem edit tools", async () => {
  const runtime = new PermissionRuntime();
  const writeTool = createPolitDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPolitDeckToolRuntimeFixture({ permissionMode: "acceptEdits" });

  assert.equal((await runtime.decide(writeTool, {}, context, "call-1")).type, "allow");
});

test("deny and ask rules take priority over allow and bypass", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPolitDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPolitDeckToolRuntimeFixture({ permissionMode: "bypassPermissions", canPrompt: true });

  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    canPrompt: true,
    rules: {
      deny: [{ source: "project", behavior: "deny", toolName: "bash" }],
      allow: [{ source: "user", behavior: "allow", toolName: "bash" }],
    },
  });
  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "deny");

  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    canPrompt: true,
    rules: {
      ask: [{ source: "project", behavior: "ask", toolName: "bash" }],
      allow: [{ source: "user", behavior: "allow", toolName: "bash" }],
    },
  });
  assert.equal((await runtime.decide(tool, {}, context, "call-2")).type, "ask");
});

test("dontAsk converts ask decisions to deny", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPolitDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPolitDeckToolRuntimeFixture({ permissionMode: "dontAsk", canPrompt: true });

  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "deny");
});

test("tool safety deny is not bypassed", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPolitDeckTestTool({
    name: "bash",
    readOnly: false,
    kind: "shell",
    permissionResult: {
      type: "deny",
      reason: { type: "safety", message: "Dangerous command denied." },
      message: "Dangerous command denied.",
    },
  });
  const { context } = createPolitDeckToolRuntimeFixture({ permissionMode: "bypassPermissions" });

  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "deny");
});
