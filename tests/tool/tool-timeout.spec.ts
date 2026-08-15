/**
 * Registry 级工具超时测试（阶段四 T6.1）。
 *
 * 原语层（fuseToolTimeout / isToolTimeout）+ ToolRuntime 集成层：合作式工具在
 * deadline 处观察到熔合 signal 并抛错、或忽略 signal 正常返回后，均归一为
 * 结构化 tool_timeout；调用方取消则保持非超时语义。
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { PermissionRuntime } from "../../src/permission/index.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { fuseToolTimeout, isToolTimeout } from "../../src/tool/execution/toolTimeout.js";

function context(): SatiToolRuntimeContext {
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
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  };
}

/** 合作式慢工具：在 deadline 处观察到 signal 后自行抛错（abort 类）。 */
function cooperativeAbortTool(timeoutMs: number): SatiToolDefinition {
  return {
    name: "cooperative_abort_tool",
    description: "cooperative tool that observes the fused signal and throws at deadline",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (_input, toolContext) => {
      await new Promise<void>(resolve => {
        const signal = toolContext.abortSignal;
        // 兜底必须保持 ref：AbortSignal.timeout 的内部定时器是 unref 的，
        // 若唯一挂起句柄只有它，事件循环会提前清空（测试被 node:test 判定
        // 悬挂）。ref 的 guard 保证循环存活到 deadline 触发。
        const guard = setTimeout(resolve, 2000);
        const done = () => {
          clearTimeout(guard);
          resolve();
        };
        if (signal?.aborted) {
          done();
          return;
        }
        signal?.addEventListener("abort", done, { once: true });
        // 竞态窗口：abort 在检查与监听之间触发时补判一次。
        if (signal?.aborted) {
          done();
        }
      });
      throw new Error("aborted at deadline (signal fired)");
    },
  };
}

/** 忽略 signal 的慢工具：到点后仍正常返回。 */
function signalIgnoringTool(timeoutMs: number, workMs: number): SatiToolDefinition {
  return {
    name: "signal_ignoring_tool",
    description: "cooperative tool that ignores the fused signal and returns normally after deadline",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async () => {
      await sleep(workMs);
      return { content: [{ type: "text", text: "done late" }] };
    },
  };
}

function createRuntime(tool: SatiToolDefinition): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new ToolRuntime(registry, new PermissionRuntime());
}

test("fuseToolTimeout + isToolTimeout: deadline 到期判定为超时", async () => {
  const parent = new AbortController().signal;
  const fused = fuseToolTimeout(parent, 15);
  assert.equal(fused.aborted, false);
  await sleep(40);
  assert.equal(fused.aborted, true);
  assert.equal(isToolTimeout(fused, parent), true);
});

test("isToolTimeout: 调用方先取消则不是超时", () => {
  const controller = new AbortController();
  const fused = fuseToolTimeout(controller.signal, 1000);
  controller.abort(new Error("caller abort"));
  assert.equal(fused.aborted, true);
  assert.equal(isToolTimeout(fused, controller.signal), false);
});

test("无父信号: deadline 独立生效", async () => {
  const fused = fuseToolTimeout(undefined, 15);
  assert.equal(fused.aborted, false);
  await sleep(40);
  assert.equal(fused.aborted, true);
  assert.equal(isToolTimeout(fused, undefined), true);
});

test("集成：合作式工具在 deadline 抛错 → 归一为 tool_timeout", async () => {
  const runtime = createRuntime(cooperativeAbortTool(20));
  const result = await runtime.execute({ id: "call-1", name: "cooperative_abort_tool", input: {} }, context());
  assert.equal(result.type, "error");
  assert.equal(result.error.code, "tool_timeout");
  assert.match(result.error.message, /exceeded its 20ms budget/);
});

test("集成：忽略 signal 的工具超时后正常返回 → 返回时判定为 tool_timeout", async () => {
  const runtime = createRuntime(signalIgnoringTool(20, 80));
  const result = await runtime.execute({ id: "call-2", name: "signal_ignoring_tool", input: {} }, context());
  assert.equal(result.type, "error");
  assert.equal(result.error.code, "tool_timeout");
});

test("集成：调用方取消（非 deadline）→ 不是 tool_timeout", async () => {
  const controller = new AbortController();
  const runtime = createRuntime(cooperativeAbortTool(10_000));
  const abortSignal = controller.signal;
  const pending = runtime.execute(
    { id: "call-3", name: "cooperative_abort_tool", input: {} },
    {
      ...context(),
      abortSignal,
    },
  );
  await sleep(20);
  controller.abort(new Error("caller cancel"));
  const result = await pending;
  assert.equal(result.type, "error");
  assert.notEqual(result.error.code, "tool_timeout");
});
