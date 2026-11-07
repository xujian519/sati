/**
 * 有界并发调度：上限、顺序、独占屏障，以及准备阶段输入变化后的并发安全复核。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import type { PermissionDecision } from "../../../src/permission/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function exclusiveFlag(input: unknown): boolean {
  return Boolean(input && typeof input === "object" && (input as Record<string, unknown>).exclusive === true);
}

class AllowAllPermissionRuntime extends PermissionRuntime {
  constructor(private readonly updatedInput?: unknown) {
    super();
  }

  override async decide(
    _tool: SatiToolDefinition,
    _input: unknown,
    _context: SatiToolRuntimeContext,
    _toolCallId: string,
  ): Promise<PermissionDecision> {
    return {
      type: "allow",
      reason: { type: "runtime", message: "test allow" },
      ...(this.updatedInput === undefined ? {} : { updatedInput: this.updatedInput }),
    };
  }
}

function makeContext(): SatiToolRuntimeContext {
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
  };
}

type Tracker = {
  active: number;
  maxActive: number;
  order: string[];
};

function makeTrackedTool(
  tracker: Tracker,
  options: { updatedInput?: unknown; isConcurrencySafe?: (input: unknown) => boolean } = {},
): { tool: SatiToolDefinition; runtime: ToolRuntime; scheduler: ConcurrentToolScheduler } {
  const tool: SatiToolDefinition = {
    name: "tracked_tool",
    description: "tracks concurrency",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { label: { type: "string" }, exclusive: { type: "boolean" } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: options.isConcurrencySafe ?? (() => true),
    execute: async input => {
      const label =
        input && typeof input === "object" && typeof (input as Record<string, unknown>).label === "string"
          ? ((input as Record<string, unknown>).label as string)
          : "?";
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      tracker.order.push(label);
      try {
        await delay(5);
      } finally {
        tracker.active -= 1;
      }
      return { content: [{ type: "text", text: label }] };
    },
  };

  const registry = new ToolRegistry();
  registry.register(tool);
  const runtime = new ToolRuntime(registry, new AllowAllPermissionRuntime(options.updatedInput));
  return { tool, runtime, scheduler: new ConcurrentToolScheduler(runtime, registry, { maxConcurrency: 2 }) };
}

test("并发上限生效且结果按原始调用顺序回填", async () => {
  const tracker: Tracker = { active: 0, maxActive: 0, order: [] };
  const { scheduler } = makeTrackedTool(tracker);
  const calls = ["a", "b", "c", "d", "e", "f"].map(label => ({
    id: `call-${label}`,
    name: "tracked_tool",
    input: { label },
  }));

  const results = await scheduler.executeAll(calls, makeContext());

  assert.equal(tracker.maxActive, 2);
  assert.deepEqual(
    results.map(result => result.toolCallId),
    calls.map(call => call.id),
  );
  assert.deepEqual([...tracker.order].sort(), ["a", "b", "c", "d", "e", "f"]);
});

test("独占调用作为屏障：不与并发安全调用重叠", async () => {
  const tracker: Tracker = { active: 0, maxActive: 0, order: [] };
  const { scheduler } = makeTrackedTool(tracker, {
    isConcurrencySafe: input => !exclusiveFlag(input),
  });
  const calls = [
    { id: "call-1", name: "tracked_tool", input: { label: "safe-1" } },
    { id: "call-2", name: "tracked_tool", input: { label: "exclusive", exclusive: true } },
    { id: "call-3", name: "tracked_tool", input: { label: "safe-2" } },
    { id: "call-4", name: "tracked_tool", input: { label: "safe-3" } },
  ];

  const results = await scheduler.executeAll(calls, makeContext());

  assert.equal(tracker.maxActive, 2);
  // 屏障前有 safe-1，屏障后才可能出现 safe-2/safe-3。
  assert.deepEqual(tracker.order.slice(0, 2), ["safe-1", "exclusive"]);
  assert.deepEqual(
    results.map(result => result.toolCallId),
    calls.map(call => call.id),
  );
});

test("maxConcurrency 非正整数时构造期失败", () => {
  const registry = new ToolRegistry();
  const runtime = new ToolRuntime(registry, new AllowAllPermissionRuntime());
  assert.throws(() => new ConcurrentToolScheduler(runtime, registry, { maxConcurrency: 0 }), RangeError);
  assert.throws(() => new ConcurrentToolScheduler(runtime, registry, { maxConcurrency: 1.5 }), RangeError);
});

test("准备阶段输入从并发安全变为独占时，调度拒绝并要求单独重试", async () => {
  const tracker: Tracker = { active: 0, maxActive: 0, order: [] };
  const { scheduler } = makeTrackedTool(tracker, {
    // 权限改写后固定变成独占输入。
    updatedInput: { label: "rewritten", exclusive: true },
    isConcurrencySafe: input => !exclusiveFlag(input),
  });
  const calls = [
    { id: "call-1", name: "tracked_tool", input: { label: "one" } },
    { id: "call-2", name: "tracked_tool", input: { label: "two" } },
  ];

  const results = await scheduler.executeAll(calls, makeContext());

  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.type, "error");
    if (result.type === "error") {
      assert.equal(result.error.code, "tool_execution_failed");
      assert.match(result.error.message, /Retry this tool call alone/);
    }
  }
  assert.deepEqual(tracker.order, []);
});
