import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { createPilotDeckTestTool, createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("default mode allows read-only tools and asks for write tools", async () => {
  const runtime = new PermissionRuntime();
  const readTool = createPilotDeckTestTool({ name: "read_file", readOnly: true });
  const writeTool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "default", canPrompt: true });

  assert.equal((await runtime.decide(readTool, {}, context, "call-1")).type, "allow");
  assert.equal((await runtime.decide(writeTool, {}, context, "call-2")).type, "ask");
});

test("plan mode allows read-only tools and denies side-effecting tools", async () => {
  const runtime = new PermissionRuntime();
  const readTool = createPilotDeckTestTool({ name: "read_file", readOnly: true });
  const writeTool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "plan" });

  assert.equal((await runtime.decide(readTool, {}, context, "call-1")).type, "allow");
  assert.equal((await runtime.decide(writeTool, {}, context, "call-2")).type, "deny");
});

test("plan mode allows writing only the configured plan file", async () => {
  const runtime = new PermissionRuntime();
  const writeTool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "plan" });
  context.permissionContext.planDirectoryPath = "/tmp/demo/.pilotdeck/plans";

  const allowed = await runtime.decide(
    writeTool,
    { filePath: "/tmp/demo/.pilotdeck/plans/plan.md" },
    context,
    "call-allowed",
  );
  const denied = await runtime.decide(
    writeTool,
    { filePath: "/tmp/demo/README.md" },
    context,
    "call-denied",
  );
  const deniedNonMarkdown = await runtime.decide(
    writeTool,
    { filePath: "/tmp/demo/.pilotdeck/plans/plan.txt" },
    context,
    "call-denied-non-markdown",
  );

  assert.equal(allowed.type, "allow");
  assert.equal(denied.type, "deny");
  assert.equal(deniedNonMarkdown.type, "deny");
});

test("acceptEdits allows filesystem edit tools", async () => {
  const runtime = new PermissionRuntime();
  const writeTool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "acceptEdits" });

  assert.equal((await runtime.decide(writeTool, {}, context, "call-1")).type, "allow");
});

test("deny and ask rules take priority over allow and bypass", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "bypassPermissions", canPrompt: true });

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

test("session allow can temporarily override user deny only", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "bypassPermissions", canPrompt: true });

  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    canPrompt: true,
    rules: {
      deny: [{ source: "user", behavior: "deny", toolName: "bash", pattern: "pwd:*" }],
      allow: [{ source: "session", behavior: "allow", toolName: "bash", pattern: "pwd:*" }],
    },
  });
  assert.equal((await runtime.decide(tool, { command: "pwd" }, context, "call-session")).type, "allow");

  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    canPrompt: true,
    rules: {
      deny: [{ source: "project", behavior: "deny", toolName: "bash", pattern: "pwd:*" }],
      allow: [{ source: "session", behavior: "allow", toolName: "bash", pattern: "pwd:*" }],
    },
  });
  assert.equal((await runtime.decide(tool, { command: "pwd" }, context, "call-project")).type, "deny");
});

test("dontAsk converts ask decisions to deny", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "dontAsk", canPrompt: true });

  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "deny");
});

test("tool safety deny is not bypassed", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({
    name: "bash",
    readOnly: false,
    kind: "shell",
    permissionResult: {
      type: "deny",
      reason: { type: "safety", message: "Dangerous command denied." },
      message: "Dangerous command denied.",
    },
  });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "bypassPermissions" });

  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "deny");
});

test("session allow does not bypass tool safety deny", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({
    name: "bash",
    readOnly: false,
    kind: "shell",
    permissionResult: {
      type: "deny",
      reason: { type: "safety", message: "Dangerous command denied." },
      message: "Dangerous command denied.",
    },
  });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "bypassPermissions" });
  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    rules: {
      deny: [{ source: "user", behavior: "deny", toolName: "bash" }],
      allow: [{ source: "session", behavior: "allow", toolName: "bash" }],
    },
  });

  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "deny");
});

test("bypassPermissions overrides a tool's hardcoded checkPermissions ask", async () => {
  const runtime = new PermissionRuntime();
  // Mirrors the web_search / web_fetch / agent dispatch pattern: tool
  // hardcodes `ask` in checkPermissions to gate network/side-effect
  // access. Under `bypassPermissions` the user has explicitly said
  // "approve everything" — that should win over the tool's ask, the
  // same way an explicit allow rule does.
  const tool = createPilotDeckTestTool({
    name: "web_search",
    readOnly: true,
    kind: "network",
    permissionResult: {
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "web search",
        reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
        options: [
          { id: "allow_once", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    },
  });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "bypassPermissions" });

  const decision = await runtime.decide(tool, {}, context, "call-1");
  assert.equal(decision.type, "allow");
});

test("plan mode overrides a read-only tool's hardcoded checkPermissions ask", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({
    name: "web_search",
    readOnly: true,
    kind: "network",
    permissionResult: {
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "web search",
        reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
        options: [
          { id: "allow_once", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    },
  });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "plan", canPrompt: true });

  const decision = await runtime.decide(tool, {}, context, "call-1");
  assert.equal(decision.type, "allow");
});

test("default mode still respects a tool's hardcoded checkPermissions ask", async () => {
  const runtime = new PermissionRuntime();
  const tool = createPilotDeckTestTool({
    name: "web_search",
    readOnly: true,
    kind: "network",
    permissionResult: {
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "web search",
        reason: { type: "tool", toolName: "web_search", message: "Network search requires permission." },
        options: [
          { id: "allow_once", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    },
  });
  const { context } = createPilotDeckToolRuntimeFixture({ permissionMode: "default", canPrompt: true });

  assert.equal((await runtime.decide(tool, {}, context, "call-1")).type, "ask");
});
