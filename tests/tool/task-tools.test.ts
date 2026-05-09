import test from "node:test";
import assert from "node:assert/strict";
import {
  BackgroundTaskRuntime,
} from "../../src/task/index.js";
import {
  createTaskCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
} from "../../src/tool/index.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("C5.TOOLS unsupported_tool when no runtime is wired", async () => {
  const tool = createTaskCreateTool();
  const { context } = createPolitDeckToolRuntimeFixture({ tools: [tool] });
  await assert.rejects(
    () => tool.execute({ command: "echo x" }, context),
    /BackgroundTaskRuntime/,
  );
});

test("C5.TOOLS task_create + task_list + task_output + task_stop happy path", async () => {
  const runtime = new BackgroundTaskRuntime();
  const create = createTaskCreateTool(runtime);
  const list = createTaskListTool(runtime);
  const output = createTaskOutputTool(runtime);
  const stop = createTaskStopTool(runtime);

  const { context } = createPolitDeckToolRuntimeFixture({ tools: [create, list, output, stop] });

  const created = await create.execute(
    { command: "echo abc && echo def", agentId: "agent-x" },
    context,
  );
  const taskId = created.data!.taskId;
  assert.ok(taskId);
  await runtime.waitFor(taskId);

  const listed = await list.execute({ agentId: "agent-x" }, context);
  assert.equal(listed.data!.tasks.length, 1);
  assert.equal(listed.data!.tasks[0]?.taskId, taskId);

  const out = await output.execute({ taskId }, context);
  assert.match(out.data!.content, /abc/);
  assert.match(out.data!.content, /def/);
  assert.equal(out.data!.status, "completed");

  const stopped = await stop.execute({ taskId }, context);
  assert.equal(stopped.data!.status, "completed");
});

test("C5.TOOLS task_output rejects unknown taskId", async () => {
  const runtime = new BackgroundTaskRuntime();
  const output = createTaskOutputTool(runtime);
  const { context } = createPolitDeckToolRuntimeFixture({ tools: [output] });
  await assert.rejects(
    () => output.execute({ taskId: "nope" }, context),
    /Unknown taskId/,
  );
});
