/**
 * `alwaysAsk` 与 PermissionRequest hook 的边界测试。
 *
 * 该标记的承诺是「自动放行抹不掉」：只有宿主注册的交互式 callback hook（网关
 * 权限提示 = 用户本人作答）能批准 alwaysAsk 工具；声明式 hook（command / prompt /
 * http / agent，其中 command 可由项目仓库自带）的 allow 一律不算数。
 *
 * 此前该区域零测试覆盖（`createGatewayPermissionHook` / `GatewayPermissionBus`
 * 在 tests/ 下无任何引用）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandHookExecutor } from "../../../src/extension/hooks/execution/CommandHookExecutor.js";
import { HookRuntime } from "../../../src/extension/hooks/execution/HookRuntime.js";
import type { SatiHookOutput, SatiHookSyncOutput } from "../../../src/extension/hooks/protocol/output.js";
import type { SatiHooksSettings } from "../../../src/extension/hooks/protocol/settings.js";
import {
  createGatewayPermissionHook,
  GATEWAY_PERMISSION_CALLBACK_NAME,
} from "../../../src/gateway/permission/createGatewayPermissionHook.js";
import { GatewayPermissionBus } from "../../../src/gateway/permission/GatewayPermissionBus.js";
import { LifecycleRuntime } from "../../../src/lifecycle/runtime/LifecycleRuntime.js";
import { PermissionRuntime } from "../../../src/permission/index.js";
import type { PermissionRule } from "../../../src/permission/protocol/types.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function allowOutput(): SatiHookSyncOutput {
  return { type: "sync", specific: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
}

/** 声明式 command hook 的替身：不发子进程，直接返回指定的 hook 输出。 */
function fakeCommandExecutor(output: SatiHookOutput): CommandHookExecutor {
  return {
    execute: async () => ({ stdout: "", stderr: "", exitCode: 0, outcome: "success" as const, output }),
  };
}

function hookInput() {
  return {
    sessionId: "s1",
    transcriptPath: "",
    cwd: process.cwd(),
    hookEventName: "PermissionRequest" as const,
    toolName: "test_tool",
    toolInput: {},
    toolUseId: "call-1",
  };
}

/** 声明式（磁盘可声明）hook：项目仓库自带 hooks.json 即可走到这条路径。 */
function declarativeHooks(): HookRuntime {
  return new HookRuntime(
    { PermissionRequest: [{ hooks: [{ type: "command", command: "noop" }] }] },
    fakeCommandExecutor(allowOutput()),
  );
}

/** 宿主注册的交互式 hook（等价于网关权限提示）。 */
function interactiveHooks(handler: () => SatiHookSyncOutput): HookRuntime {
  const hooks: SatiHooksSettings = {
    PermissionRequest: [{ hooks: [{ type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME }] }],
  };
  const runtime = new HookRuntime(hooks);
  runtime.getCallbackExecutor().register(GATEWAY_PERMISSION_CALLBACK_NAME, handler);
  return runtime;
}

function makeTool(alwaysAsk: boolean): SatiToolDefinition {
  return {
    name: "test_tool",
    description: "test tool",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    ...(alwaysAsk ? { alwaysAsk: true as const } : {}),
    execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
  };
}

function makeContext(): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function runtimeWith(alwaysAsk: boolean, hookRuntime: HookRuntime): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(makeTool(alwaysAsk));
  return new ToolRuntime(registry, new PermissionRuntime(), new LifecycleRuntime(hookRuntime));
}

// ---------------------------------------------------------------------------
// HookRuntime：effect 上的 interactive 来源位
// ---------------------------------------------------------------------------

test("宿主注册的 callback hook 决策带 interactive 位", async () => {
  const result = await interactiveHooks(allowOutput).run({
    event: "PermissionRequest",
    hookInput: hookInput(),
    cwd: process.cwd(),
  });
  const effect = result.effects.find(e => e.type === "permission_request_result");
  assert.ok(effect, "应产出 permission_request_result effect");
  assert.equal(effect.interactive, true);
});

test("声明式 command hook 的决策不带 interactive 位", async () => {
  const result = await declarativeHooks().run({
    event: "PermissionRequest",
    hookInput: hookInput(),
    cwd: process.cwd(),
  });
  const effect = result.effects.find(e => e.type === "permission_request_result");
  assert.ok(effect, "应产出 permission_request_result effect");
  assert.notEqual(effect.interactive, true);
});

// ---------------------------------------------------------------------------
// ToolRuntime：谁能批准 alwaysAsk 工具
// ---------------------------------------------------------------------------

test("alwaysAsk 工具：声明式 hook 的 allow 不能放行", async () => {
  const result = await runtimeWith(true, declarativeHooks()).execute(
    { id: "call-1", name: "test_tool", input: {} },
    makeContext(),
  );
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_required");
});

test("alwaysAsk 工具：宿主交互式 hook 的 allow 仍可放行", async () => {
  const result = await runtimeWith(true, interactiveHooks(allowOutput)).execute(
    { id: "call-1", name: "test_tool", input: {} },
    makeContext(),
  );
  assert.equal(result.type, "success");
});

test("alwaysAsk 工具：宿主交互式 hook 的 deny 生效", async () => {
  const deny = (): SatiHookSyncOutput => ({
    type: "sync",
    specific: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "用户拒绝" } },
  });
  const result = await runtimeWith(true, interactiveHooks(deny)).execute(
    { id: "call-1", name: "test_tool", input: {} },
    makeContext(),
  );
  assert.equal(result.type, "error");
  if (result.type === "error") assert.match(result.error.message, /用户拒绝/);
});

test("未标记 alwaysAsk 的工具：声明式 hook 的 allow 照旧放行（回归）", async () => {
  const result = await runtimeWith(false, declarativeHooks()).execute(
    { id: "call-1", name: "test_tool", input: {} },
    makeContext(),
  );
  assert.equal(result.type, "success");
});

// ---------------------------------------------------------------------------
// 网关权限 hook：alwaysAsk 不落会话级授权
// ---------------------------------------------------------------------------

async function runGatewayHook(extraInput: Record<string, unknown>): Promise<PermissionRule[]> {
  const bus = new GatewayPermissionBus();
  const rules: PermissionRule[] = [];
  const handler = createGatewayPermissionHook({
    sessionKey: "s1",
    bus,
    emit: () => true,
    permissionRules: rules,
    uuid: () => "req-1",
  });
  const pending = handler({ hookInput: { ...hookInput(), ...extraInput } });
  // handler 在首个 await 之前同步注册到 bus，故此处可直接消费轮次。
  bus.consume("s1", "req-1")?.resolve({ requestId: "req-1", decision: "allow", remember: true });
  await pending;
  return rules;
}

test("alwaysAsk 命中时不落会话级 allow 规则（「记住」对该工具无效）", async () => {
  const rules = await runGatewayHook({ alwaysAsk: true, permissionSuggestions: [] });
  assert.equal(rules.length, 0);
});

test("非 alwaysAsk 工具仍按「记住」落会话级 allow 规则（回归）", async () => {
  const rules = await runGatewayHook({ permissionSuggestions: [] });
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.source, "session");
});
