/**
 * 工具调用的 hook 归属透传：fork 会话内的工具调用必须把子代理身份写进
 * 生命周期 hook 输入（`agentId` / `agentType`）。
 *
 * 这两个字段是 hook 协议里既有但此前从未填充的：网关权限 hook 拿到它们才能
 * 在 `permission_request` 帧上标出「谁在请求」——只靠 sessionId 的 `::sub::`
 * 标记反解拿不到子代理类型。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import type { LifecycleRuntime } from "../../../src/lifecycle/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

type DispatchedHook = {
  event: string;
  baseInput: { sessionId: string; agentId?: string; agentType?: string };
};

function stubLifecycle(): { lifecycle: LifecycleRuntime; dispatched: DispatchedHook[] } {
  const dispatched: DispatchedHook[] = [];
  const lifecycle = {
    dispatch: async (input: DispatchedHook) => {
      dispatched.push(input);
      return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
    },
  } as unknown as LifecycleRuntime;
  return { lifecycle, dispatched };
}

const echoTool: SatiToolDefinition = {
  name: "identity_echo_tool",
  description: "returns ok",
  kind: "custom",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

function context(extra: Partial<SatiToolRuntimeContext> = {}): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    ...extra,
  };
}

function createRuntime(lifecycle: LifecycleRuntime): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return new ToolRuntime(registry, new PermissionRuntime(), lifecycle);
}

test("ToolRuntime：fork 会话的工具调用把 subagentId/subagentType 填进 hook 输入", async () => {
  const { lifecycle, dispatched } = stubLifecycle();
  await createRuntime(lifecycle).execute(
    { id: "call-1", name: "identity_echo_tool", input: {} },
    context({ sessionId: "/proj::sub::fork-1", subagentId: "fork-1", subagentType: "explore" }),
  );

  assert.ok(dispatched.length > 0, "工具执行必须派发生命周期 hook");
  const pre = dispatched.find(entry => entry.event === "PreToolUse");
  assert.ok(pre, "必须有 PreToolUse 派发");
  assert.equal(pre.baseInput.sessionId, "/proj::sub::fork-1");
  assert.equal(pre.baseInput.agentId, "fork-1");
  assert.equal(pre.baseInput.agentType, "explore");
});

test("ToolRuntime：主代理调用不写 agentId/agentType（无归属不得凭空值伪造）", async () => {
  const { lifecycle, dispatched } = stubLifecycle();
  await createRuntime(lifecycle).execute({ id: "call-1", name: "identity_echo_tool", input: {} }, context());

  const pre = dispatched.find(entry => entry.event === "PreToolUse");
  assert.ok(pre);
  assert.equal("agentId" in pre.baseInput, false);
  assert.equal("agentType" in pre.baseInput, false);
});
