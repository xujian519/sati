/**
 * 权限 / PreToolUse 改写输入后的重新校验。
 *
 * 安全不变量：真正交给 `tool.execute` 的输入，必须已经过 schema、plan/ask 模式、
 * 提示能力与工具级 `validateInput` 的校验。改写发生在校验之后，所以每一处
 * 改写都必须重跑校验门——否则「校验过的输入」与「执行的输入」会脱钩。
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { SatiHookSyncOutput } from "../../../src/extension/hooks/protocol/output.js";
import { HookRuntime } from "../../../src/extension/hooks/execution/HookRuntime.js";
import { LifecycleRuntime } from "../../../src/lifecycle/runtime/LifecycleRuntime.js";
import { PermissionRuntime } from "../../../src/permission/index.js";
import type { PermissionDecision } from "../../../src/permission/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { SatiToolValidationResult } from "../../../src/tool/protocol/schema.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { SatiToolResult } from "../../../src/tool/protocol/result.js";

function readMode(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const mode = (input as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode : undefined;
}

type TestTool = {
  tool: SatiToolDefinition;
  executions: unknown[];
};

function makeTool(overrides: Partial<SatiToolDefinition> = {}): TestTool {
  const executions: unknown[] = [];
  const tool: SatiToolDefinition = {
    name: "test_tool",
    description: "test tool",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["read", "write"] },
      },
    },
    isReadOnly: input => readMode(input) !== "write",
    isConcurrencySafe: input => readMode(input) !== "write",
    execute: async input => {
      executions.push(input);
      return { content: [{ type: "text", text: "executed" }] };
    },
    ...overrides,
  };
  return { tool, executions };
}

function makeContext(overrides: Partial<SatiToolRuntimeContext> = {}): SatiToolRuntimeContext {
  const cwd = process.cwd();
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
    ...overrides,
  };
}

/** 权限判定替身：直接返回指定结论，可借此模拟 hook 改写后的输入。 */
class StubPermissionRuntime extends PermissionRuntime {
  constructor(private readonly decideFn: (context: SatiToolRuntimeContext) => PermissionDecision) {
    super();
  }

  override async decide(
    _tool: SatiToolDefinition,
    _input: unknown,
    context: SatiToolRuntimeContext,
    _toolCallId: string,
  ): Promise<PermissionDecision> {
    return this.decideFn(context);
  }
}

function allowWith(updatedInput: unknown): PermissionDecision {
  return {
    type: "allow",
    reason: { type: "runtime", message: "test allow" },
    updatedInput,
  };
}

function runtimeWith(tool: SatiToolDefinition, decision: PermissionDecision | (() => PermissionDecision)): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(tool);
  const permissionRuntime = new StubPermissionRuntime(typeof decision === "function" ? decision : () => decision);
  return new ToolRuntime(registry, permissionRuntime);
}

function errorCode(result: SatiToolResult): string {
  assert.equal(result.type, "error");
  if (result.type !== "error") {
    throw new Error("unreachable");
  }
  return result.error.code;
}

function firstText(result: SatiToolResult): string {
  const block = result.content?.find(item => item.type === "text");
  return block?.type === "text" ? block.text : "";
}

test("权限改写后的非法 schema 被拒绝，工具不执行", async () => {
  const { tool, executions } = makeTool();
  const result = await runtimeWith(tool, allowWith({ path: 42 })).execute(
    { id: "call-1", name: "test_tool", input: { path: "ok.txt" } },
    makeContext(),
  );

  assert.equal(errorCode(result), "invalid_tool_input");
  assert.equal(executions.length, 0);
});

test("合法的权限改写仍可执行（防误杀）", async () => {
  const { tool, executions } = makeTool();
  const result = await runtimeWith(tool, allowWith({ path: "final.txt", mode: "read" })).execute(
    { id: "call-1", name: "test_tool", input: { path: "ok.txt" } },
    makeContext(),
  );

  assert.equal(result.type, "success");
  assert.deepEqual(executions, [{ path: "final.txt", mode: "read" }]);
});

test("权限改写把只读调用改成写调用时，plan 模式重新拦截", async () => {
  const planDirectory = {
    path: resolve(process.cwd(), ".sati/plans"),
    resolve: () => undefined,
    read: () => undefined,
  };
  const { tool, executions } = makeTool({
    name: "write_file",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
  });
  const context = makeContext({
    permissionMode: "plan",
    planDirectory,
    permissionContext: {
      mode: "plan",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  });

  const result = await runtimeWith(tool, allowWith({ file_path: "src/index.ts" })).execute(
    { id: "call-1", name: "write_file", input: { file_path: ".sati/plans/plan.md" } },
    context,
  );

  assert.equal(errorCode(result), "plan_mode_violation");
  assert.equal(executions.length, 0);
});

test("权限改写把只读调用改成写调用时，ask 模式重新拦截", async () => {
  const { tool, executions } = makeTool({ name: "read_file" });
  const context = makeContext({ runMode: "ask" });

  const result = await runtimeWith(tool, allowWith({ path: "ok.txt", mode: "write" })).execute(
    { id: "call-1", name: "read_file", input: { path: "ok.txt", mode: "read" } },
    context,
  );

  assert.equal(errorCode(result), "ask_mode_violation");
  assert.equal(executions.length, 0);
});

test("权限改写后需要提问但会话不能提问时拒绝", async () => {
  const { tool, executions } = makeTool({
    requiresUserInteraction: input => readMode(input) === "write",
  });
  const context = makeContext({
    permissionContext: {
      mode: "default",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  });

  const result = await runtimeWith(tool, allowWith({ path: "ok.txt", mode: "write" })).execute(
    { id: "call-1", name: "test_tool", input: { path: "ok.txt", mode: "read" } },
    context,
  );

  assert.equal(errorCode(result), "unsupported_tool");
  assert.equal(executions.length, 0);
});

test("权限判定期间被取消时，执行前重新检查 abort", async () => {
  const { tool, executions } = makeTool();
  const controller = new AbortController();
  const context = makeContext({ abortSignal: controller.signal });

  const result = await runtimeWith(tool, () => {
    controller.abort();
    return allowWith({ path: "final.txt" });
  }).execute({ id: "call-1", name: "test_tool", input: { path: "ok.txt" } }, context);

  assert.equal(errorCode(result), "tool_aborted");
  assert.equal(executions.length, 0);
});

test("权限改写后重新跑工具级 validateInput", async () => {
  const validateInput = async (input: unknown): Promise<SatiToolValidationResult> => {
    if (input && typeof input === "object" && (input as Record<string, unknown>).path === "blocked.txt") {
      return {
        ok: false,
        issues: [{ path: "$.path", code: "invalid_enum", message: "$.path is reserved." }],
      };
    }
    return { ok: true, input };
  };
  const { tool, executions } = makeTool({ validateInput });
  const result = await runtimeWith(tool, allowWith({ path: "blocked.txt" })).execute(
    { id: "call-1", name: "test_tool", input: { path: "ok.txt" } },
    makeContext(),
  );

  assert.equal(errorCode(result), "invalid_tool_input");
  assert.equal(executions.length, 0);
});

test("PreToolUse 改写输入后重新过 plan 模式门", async () => {
  const callbackName = "test-pretooluse-rewrite";
  const hookRuntime = new HookRuntime({
    PreToolUse: [{ hooks: [{ type: "callback", name: callbackName }] }],
  });
  hookRuntime.getCallbackExecutor().register(callbackName, (): SatiHookSyncOutput => {
    return {
      type: "sync",
      specific: {
        hookEventName: "PreToolUse",
        updatedInput: { file_path: "src/index.ts" },
      },
    };
  });

  const planDirectory = {
    path: resolve(process.cwd(), ".sati/plans"),
    resolve: () => undefined,
    read: () => undefined,
  };
  const { tool, executions } = makeTool({
    name: "write_file",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  const runtime = new ToolRuntime(
    registry,
    new StubPermissionRuntime(() => ({
      type: "allow",
      reason: { type: "runtime", message: "test allow" },
    })),
    new LifecycleRuntime(hookRuntime),
  );

  const result = await runtime.execute(
    { id: "call-1", name: "write_file", input: { file_path: ".sati/plans/plan.md" } },
    makeContext({
      permissionMode: "plan",
      planDirectory,
      permissionContext: {
        mode: "plan",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: true,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    }),
  );

  assert.equal(errorCode(result), "plan_mode_violation");
  assert.equal(executions.length, 0);
});

test("requireConcurrencySafe：输入从安全变为独占时拒绝并要求单独重试", async () => {
  const { tool, executions } = makeTool();
  const result = await runtimeWith(tool, allowWith({ path: "ok.txt", mode: "write" })).execute(
    { id: "call-1", name: "test_tool", input: { path: "ok.txt", mode: "read" } },
    makeContext(),
    { requireConcurrencySafe: true },
  );

  assert.equal(errorCode(result), "tool_execution_failed");
  assert.match(firstText(result), /Retry this tool call alone/);
  assert.equal(executions.length, 0);
});
