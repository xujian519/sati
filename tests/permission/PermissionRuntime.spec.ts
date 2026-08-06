import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime, createDefaultPermissionContext, type PermissionRule } from "../../src/permission/index.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../src/tool/index.js";

function makeTool(
  name: string,
  opts?: { readOnly?: boolean; checkPermissions?: SatiToolDefinition["checkPermissions"] },
): SatiToolDefinition {
  return {
    name,
    description: "test tool",
    kind: "filesystem",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => opts?.readOnly ?? false,
    isConcurrencySafe: () => false,
    ...(opts?.checkPermissions ? { checkPermissions: opts.checkPermissions } : {}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function makeContext(
  overrides: Partial<Parameters<typeof createDefaultPermissionContext>[0]> = {},
): SatiToolRuntimeContext {
  const permissionContext = createDefaultPermissionContext({
    cwd: "/home/u/proj",
    canPrompt: true,
    ...overrides,
  });
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: permissionContext.cwd,
    permissionMode: permissionContext.mode,
    permissionContext,
  };
}

function rule(overrides: Partial<PermissionRule> & { toolName: string }): PermissionRule {
  return { source: "user", behavior: "allow", ...overrides };
}

const runtime = new PermissionRuntime();

// ---------------------------------------------------------------------------
// 默认模式
// ---------------------------------------------------------------------------

test("default mode allows read-only tools without prompting", async () => {
  const tool = makeTool("read_file", { readOnly: true });
  const decision = await runtime.decide(tool, { file_path: "a.txt" }, makeContext(), "call-1");
  assert.equal(decision.type, "allow");
  if (decision.type === "allow") assert.equal(decision.reason.type, "mode");
});

test("default mode asks for non-readonly tools and builds a request", async () => {
  const tool = makeTool("write_file");
  const decision = await runtime.decide(tool, { file_path: "a.txt", content: "x" }, makeContext(), "call-1");
  assert.equal(decision.type, "ask");
  if (decision.type === "ask") {
    assert.equal(decision.request.toolCallId, "call-1");
    assert.equal(decision.request.toolName, "write_file");
    assert.deepEqual(
      decision.request.options.map(o => o.id),
      ["allow_once", "deny", "cancel"],
    );
    // input summary 截断
    assert.equal(decision.request.inputSummary, JSON.stringify({ file_path: "a.txt", content: "x" }));
  }
});

test("ask is converted to deny when prompts are disabled", async () => {
  const tool = makeTool("write_file");
  const decision = await runtime.decide(tool, {}, makeContext({ canPrompt: false }), "call-1");
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") assert.equal(decision.reason.type, "runtime");
});

test("unserializable input is summarized without throwing", async () => {
  const tool = makeTool("write_file");
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const decision = await runtime.decide(tool, cyclic, makeContext(), "call-1");
  assert.equal(decision.type, "ask");
});

// ---------------------------------------------------------------------------
// bypassPermissions 模式
// ---------------------------------------------------------------------------

test("bypassPermissions allows everything and overrides tool ask", async () => {
  const tool = makeTool("web_search", {
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "hardcoded ask" },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "",
        reason: { type: "tool", toolName: "web_search", message: "hardcoded ask" },
        options: [],
      },
    }),
  });
  const decision = await runtime.decide(tool, {}, makeContext({ mode: "bypassPermissions" }), "call-1");
  assert.equal(decision.type, "allow");
  if (decision.type === "allow") assert.equal(decision.reason.type, "mode");
});

test("bypassPermissions converts ask rules to allow", async () => {
  const tool = makeTool("write_file");
  const askRule = rule({ toolName: "write_file", behavior: "ask" });
  const decision = await runtime.decide(
    tool,
    {},
    makeContext({ mode: "bypassPermissions", rules: { ask: [askRule] } }),
    "call-1",
  );
  assert.equal(decision.type, "allow");
});

// ---------------------------------------------------------------------------
// plan 模式
// ---------------------------------------------------------------------------

test("plan mode allows read-only tools", async () => {
  const tool = makeTool("read_file", { readOnly: true });
  const decision = await runtime.decide(tool, {}, makeContext({ mode: "plan" }), "call-1");
  assert.equal(decision.type, "allow");
});

test("plan mode denies non-readonly tools", async () => {
  const tool = makeTool("write_file");
  const decision = await runtime.decide(tool, { file_path: "a.txt" }, makeContext({ mode: "plan" }), "call-1");
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") {
    assert.equal(decision.reason.type, "mode");
    assert.match(decision.message, /plan/i);
  }
});

test("plan mode deny message for bash includes the command", async () => {
  const tool = makeTool("bash");
  const decision = await runtime.decide(tool, { command: "rm -rf /" }, makeContext({ mode: "plan" }), "call-1");
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") assert.match(decision.message, /rm -rf \//);
});

test("plan mode allows markdown writes under the plan directory", async () => {
  const tool = makeTool("write_file");
  const decision = await runtime.decide(
    tool,
    { file_path: "/home/u/proj/.sati/plans/foo.md" },
    makeContext({ mode: "plan", planDirectoryPath: "/home/u/proj/.sati/plans" }),
    "call-1",
  );
  assert.equal(decision.type, "allow");
});

test("plan mode denies non-markdown writes under the plan directory", async () => {
  const tool = makeTool("write_file");
  const decision = await runtime.decide(
    tool,
    { file_path: "/home/u/proj/.sati/plans/foo.json" },
    makeContext({ mode: "plan", planDirectoryPath: "/home/u/proj/.sati/plans" }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
});

test("plan mode denies writes outside the plan directory", async () => {
  const tool = makeTool("write_file");
  const decision = await runtime.decide(
    tool,
    { file_path: "/home/u/proj/src/a.ts" },
    makeContext({ mode: "plan", planDirectoryPath: "/home/u/proj/.sati/plans" }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
});

test("plan mode overrides user allow rules for non-readonly tools", async () => {
  const tool = makeTool("write_file");
  const allowRule = rule({ toolName: "write_file" });
  const decision = await runtime.decide(
    tool,
    { file_path: "a.txt" },
    makeContext({ mode: "plan", rules: { allow: [allowRule] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
});

test("plan mode still honors user allow rules for read-only tools", async () => {
  const tool = makeTool("read_file", { readOnly: true });
  const allowRule = rule({ toolName: "read_file" });
  const decision = await runtime.decide(
    tool,
    {},
    makeContext({ mode: "plan", rules: { allow: [allowRule] } }),
    "call-1",
  );
  assert.equal(decision.type, "allow");
});

// ---------------------------------------------------------------------------
// 规则优先级
// ---------------------------------------------------------------------------

test("deny rule blocks tool in default mode", async () => {
  const tool = makeTool("bash");
  const denyRule = rule({ toolName: "bash", behavior: "deny" });
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({ rules: { deny: [denyRule] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") {
    assert.equal(decision.reason.type, "rule");
    assert.equal(decision.reason.behavior, "deny");
  }
});

test("user deny beats user allow", async () => {
  const tool = makeTool("bash");
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({
      rules: { allow: [rule({ toolName: "bash" })], deny: [rule({ toolName: "bash", behavior: "deny" })] },
    }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
});

test("session allow beats user deny", async () => {
  const tool = makeTool("bash");
  const sessionAllow = rule({ toolName: "bash", source: "session" });
  const userDeny = rule({ toolName: "bash", behavior: "deny", source: "user" });
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({ rules: { allow: [sessionAllow], deny: [userDeny] } }),
    "call-1",
  );
  assert.equal(decision.type, "allow");
});

test("session allow permits non-readonly tool when checkPermissions is passthrough", async () => {
  const tool = makeTool("bash", { checkPermissions: async () => ({ type: "passthrough" }) });
  const sessionAllow = rule({ toolName: "bash", source: "session" });
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({ rules: { allow: [sessionAllow] } }),
    "call-1",
  );
  assert.equal(decision.type, "allow");
  if (decision.type === "allow") assert.equal(decision.reason.type, "rule");
});

test("session allow does not override tool-level deny", async () => {
  const tool = makeTool("bash", {
    checkPermissions: async () => ({
      type: "deny",
      reason: { type: "tool", toolName: "bash", message: "tool denies" },
      message: "tool denies",
    }),
  });
  const sessionAllow = rule({ toolName: "bash", source: "session" });
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({ rules: { allow: [sessionAllow] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
});

test("user allow rule permits without prompting in default mode", async () => {
  const tool = makeTool("bash");
  const allowRule = rule({ toolName: "bash" });
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({ rules: { allow: [allowRule] } }),
    "call-1",
  );
  assert.equal(decision.type, "allow");
  if (decision.type === "allow") assert.equal(decision.reason.type, "rule");
});

test("user allow rule with pattern only matches matching input", async () => {
  const tool = makeTool("bash");
  const allowRule = rule({ toolName: "bash", pattern: "npm*" });
  const ok = await runtime.decide(
    tool,
    { command: "npm install" },
    makeContext({ rules: { allow: [allowRule] } }),
    "call-1",
  );
  assert.equal(ok.type, "allow");
  const blocked = await runtime.decide(
    tool,
    { command: "rm -rf /" },
    makeContext({ rules: { allow: [allowRule] } }),
    "call-2",
  );
  assert.equal(blocked.type, "ask");
});

test("ask rule requires confirmation", async () => {
  const tool = makeTool("bash");
  const askRule = rule({ toolName: "bash", behavior: "ask" });
  const decision = await runtime.decide(tool, { command: "ls" }, makeContext({ rules: { ask: [askRule] } }), "call-1");
  assert.equal(decision.type, "ask");
  if (decision.type === "ask") assert.equal(decision.reason.type, "rule");
});

// ---------------------------------------------------------------------------
// 工具自身 checkPermissions
// ---------------------------------------------------------------------------

test("tool checkPermissions deny is honored", async () => {
  const tool = makeTool("web_fetch", {
    checkPermissions: async () => ({
      type: "deny",
      reason: { type: "safety", message: "unsafe url" },
      message: "unsafe url",
    }),
  });
  const decision = await runtime.decide(tool, { url: "http://bad" }, makeContext(), "call-1");
  assert.equal(decision.type, "deny");
});

test("plan mode allows read-only tool despite checkPermissions ask", async () => {
  const tool = makeTool("web_fetch", {
    readOnly: true,
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_fetch", message: "hardcoded ask" },
      request: {
        toolCallId: "",
        toolName: "web_fetch",
        inputSummary: "",
        reason: { type: "tool", toolName: "web_fetch", message: "hardcoded ask" },
        options: [],
      },
    }),
  });
  const decision = await runtime.decide(tool, {}, makeContext({ mode: "plan" }), "call-1");
  assert.equal(decision.type, "allow");
});

test("plan mode denies non-readonly tool despite checkPermissions ask", async () => {
  const tool = makeTool("write_file", {
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "write_file", message: "hardcoded ask" },
      request: {
        toolCallId: "",
        toolName: "write_file",
        inputSummary: "",
        reason: { type: "tool", toolName: "write_file", message: "hardcoded ask" },
        options: [],
      },
    }),
  });
  const decision = await runtime.decide(tool, {}, makeContext({ mode: "plan" }), "call-1");
  assert.equal(decision.type, "deny");
});

test("checkPermissions ask in default mode becomes a prompt request", async () => {
  const tool = makeTool("web_search", {
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "hardcoded ask" },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "",
        reason: { type: "tool", toolName: "web_search", message: "hardcoded ask" },
        options: [],
      },
    }),
  });
  const decision = await runtime.decide(tool, {}, makeContext(), "call-1");
  assert.equal(decision.type, "ask");
  if (decision.type === "ask") {
    // 请求携带本次 toolCallId 与工具名
    assert.equal(decision.request.toolCallId, "call-1");
    assert.equal(decision.request.toolName, "web_search");
  }
});

test("unrecognized permission result becomes runtime ask", async () => {
  const tool = makeTool("bash", {
    checkPermissions: (async () => ({ type: "bogus" })) as unknown as SatiToolDefinition["checkPermissions"],
  });
  const decision = await runtime.decide(tool, { command: "ls" }, makeContext(), "call-1");
  assert.equal(decision.type, "ask");
  if (decision.type === "ask") assert.equal(decision.reason.type, "runtime");
});

test("user allow rule wins over tool hardcoded ask", async () => {
  const tool = makeTool("web_search", {
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "hardcoded ask" },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "",
        reason: { type: "tool", toolName: "web_search", message: "hardcoded ask" },
        options: [],
      },
    }),
  });
  const allowRule = rule({ toolName: "web_search" });
  const decision = await runtime.decide(tool, {}, makeContext({ rules: { allow: [allowRule] } }), "call-1");
  assert.equal(decision.type, "allow");
  if (decision.type === "allow") assert.equal(decision.reason.type, "rule");
});

// ---------------------------------------------------------------------------
// 无关规则不干扰
// ---------------------------------------------------------------------------

test("non-matching deny rule is ignored", async () => {
  const tool = makeTool("bash");
  const denyRule = rule({ toolName: "write_file", behavior: "deny" });
  const decision = await runtime.decide(
    tool,
    { command: "ls" },
    makeContext({ rules: { deny: [denyRule] } }),
    "call-1",
  );
  assert.equal(decision.type, "ask");
});
