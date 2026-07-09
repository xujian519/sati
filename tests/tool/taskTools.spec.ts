import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import {
  createTaskTools,
  type PilotDeckToolResult,
  type PilotDeckToolRuntimeContext,
  type TaskCreateOutput,
  type TaskOutputResult,
  type TaskWaitResult,
} from "../../src/tool/index.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

function createContext(): PilotDeckToolRuntimeContext {
  const cwd = process.cwd();
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
  };
}

function createRuntime(backgroundTasks: BackgroundTaskRuntime): ToolRuntime {
  const registry = new ToolRegistry();
  const tools = createTaskTools({ runtime: backgroundTasks });
  registry.register(tools.create);
  registry.register(tools.output);
  registry.register(tools.wait);
  registry.register(tools.stop);
  return new ToolRuntime(registry, new PermissionRuntime());
}

function successData<T>(result: PilotDeckToolResult): T {
  assert.equal(result.type, "success");
  return result.data as T;
}

function firstText(result: PilotDeckToolResult): string {
  assert.equal(result.type, "success");
  const first = result.content[0];
  assert.equal(first.type, "text");
  return first.text;
}

describe("task_wait tool", () => {
  it("waits for a successful background task and returns final output", async () => {
    const backgroundTasks = new BackgroundTaskRuntime();
    const runtime = createRuntime(backgroundTasks);
    const context = createContext();

    const created = await runtime.execute({
      id: "call-create",
      name: "task_create",
      input: { command: `${process.execPath} -e "process.stdout.write('hello')"` },
    }, context);
    const taskId = successData<TaskCreateOutput>(created).taskId;

    const waited = await runtime.execute({
      id: "call-wait",
      name: "task_wait",
      input: { taskId, timeoutMs: 1_000 },
    }, context);

    const waitedData = successData<TaskWaitResult>(waited);
    assert.equal(waitedData.status, "completed");
    assert.equal(waitedData.exitCode, 0);
    assert.equal(waitedData.timedOut, false);
    assert.match(firstText(waited), /hello/u);
    assert.match(firstText(waited), /Task finished; no further polling is needed/u);
  });

  it("returns failed status and output for a failing task", async () => {
    const backgroundTasks = new BackgroundTaskRuntime();
    const runtime = createRuntime(backgroundTasks);
    const context = createContext();

    const created = await runtime.execute({
      id: "call-create",
      name: "task_create",
      input: { command: `${process.execPath} -e "process.stderr.write('bad'); process.exit(3)"` },
    }, context);
    const createdData = successData<TaskCreateOutput>(created);

    const waited = await runtime.execute({
      id: "call-wait",
      name: "task_wait",
      input: { taskId: createdData.taskId, timeoutMs: 1_000 },
    }, context);

    const waitedData = successData<TaskWaitResult>(waited);
    assert.equal(waitedData.status, "failed");
    assert.equal(waitedData.exitCode, 3);
    assert.match(firstText(waited), /bad/u);
  });

  it("times out without stopping the task and can later read from an offset", async () => {
    const backgroundTasks = new BackgroundTaskRuntime();
    const runtime = createRuntime(backgroundTasks);
    const context = createContext();

    const created = await runtime.execute({
      id: "call-create",
      name: "task_create",
      input: { command: `${process.execPath} -e "process.stdout.write('first'); setTimeout(() => { process.stdout.write('second') }, 80)"` },
    }, context);
    const taskId = successData<TaskCreateOutput>(created).taskId;

    const early = await runtime.execute({
      id: "call-wait-early",
      name: "task_wait",
      input: { taskId, timeoutMs: 1 },
    }, context);
    const earlyData = successData<TaskWaitResult>(early);
    assert.equal(earlyData.status, "running");
    assert.equal(earlyData.timedOut, true);
    assert.match(firstText(early), /Task is still running/u);

    let offset = earlyData.nextOffset;
    for (let i = 0; i < 20 && offset === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const output = await runtime.execute({
        id: `call-output-${i}`,
        name: "task_output",
        input: { taskId },
      }, context);
      const outputData = successData<TaskOutputResult>(output);
      if (outputData.nextOffset > 0) {
        assert.match(firstText(output), /first/u);
        offset = outputData.nextOffset;
      }
    }
    assert.ok(offset > 0, "expected first chunk to be available before final wait");

    const later = await runtime.execute({
      id: "call-wait-later",
      name: "task_wait",
      input: { taskId, timeoutMs: 1_000, offset },
    }, context);
    const laterData = successData<TaskWaitResult>(later);
    assert.equal(laterData.status, "completed");
    assert.match(firstText(later), /second/u);
    assert.doesNotMatch(firstText(later), /first/u);
  });

  it("returns invalid_tool_input for unknown task ids", async () => {
    const runtime = createRuntime(new BackgroundTaskRuntime());
    const result = await runtime.execute({
      id: "call-wait",
      name: "task_wait",
      input: { taskId: "missing", timeoutMs: 1 },
    }, createContext());

    assert.equal(result.type, "error");
    assert.equal(result.error.code, "invalid_tool_input");
  });

  it("returns tool_aborted when the wait is interrupted", async () => {
    const backgroundTasks = new BackgroundTaskRuntime();
    const runtime = createRuntime(backgroundTasks);
    const controller = new AbortController();
    const context = { ...createContext(), abortSignal: controller.signal };

    const created = await runtime.execute({
      id: "call-create",
      name: "task_create",
      input: { command: `${process.execPath} -e "setTimeout(() => {}, 10000)"` },
    }, context);
    const taskId = successData<TaskCreateOutput>(created).taskId;
    setTimeout(() => controller.abort(), 1).unref();

    const result = await runtime.execute({
      id: "call-wait",
      name: "task_wait",
      input: { taskId, timeoutMs: 1_000 },
    }, context);

    assert.equal(result.type, "error");
    assert.equal(result.error.code, "tool_aborted");
    assert.equal(backgroundTasks.get(taskId)?.status, "running");
    await backgroundTasks.stop(taskId, { graceMs: 1 });
  });
});
