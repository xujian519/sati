import test from "node:test";
import assert from "node:assert/strict";
import { createPlanTodoStateManager } from "../../src/agent/runtime/PlanTodoState.js";
import { createTodoWriteTool, parseTodoMarkdown } from "../../src/tool/builtin/todoWrite.js";
import { createPilotDeckTestTool, createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("parseTodoMarkdown maps markdown checklist to todo statuses", () => {
  assert.deepEqual(parseTodoMarkdown(""), []);
  assert.deepEqual(
    parseTodoMarkdown(["- [x] first", "- [ ] second", "- [ ] third"].join("\n")),
    [
      { id: "todo-1", content: "first", status: "completed" },
      { id: "todo-2", content: "second", status: "in_progress" },
      { id: "todo-3", content: "third", status: "pending" },
    ],
  );
});

test("todo_write records checklist state for the current session", async () => {
  const manager = createPlanTodoStateManager();
  const handle = manager.forSession("test-session");
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createTodoWriteTool()],
    permissionMode: "bypassPermissions",
  });
  context.planTodo = handle;

  const result = await toolRuntime.execute({
    id: "todo-1",
    name: "todo_write",
    input: { markdown: "- [ ] draft plan\n- [ ] implement" },
  }, context);

  assert.equal(result.type, "success");
  assert.deepEqual(handle.getSnapshot().todos, [
    { id: "todo-1", content: "draft plan", status: "in_progress" },
    { id: "todo-2", content: "implement", status: "pending" },
  ]);
});

test("ToolRuntime blocks side-effect tools until todo_write initializes and refreshes the checklist", async () => {
  const manager = createPlanTodoStateManager();
  const handle = manager.forSession("test-session");
  handle.markPlanApproved("# Plan\n\n- step one");

  const writeTool = createPilotDeckTestTool({
    name: "write_test",
    readOnly: false,
    execute: async () => ({ content: [{ type: "text", text: "wrote" }] }),
  });
  const readTool = createPilotDeckTestTool({
    name: "read_test",
    readOnly: true,
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createTodoWriteTool(), writeTool, readTool],
    permissionMode: "bypassPermissions",
  });
  context.planTodo = handle;

  const blockedBeforeInit = await toolRuntime.execute({
    id: "write-1",
    name: "write_test",
    input: {},
  }, context);
  assert.equal(blockedBeforeInit.type, "error");
  if (blockedBeforeInit.type === "error") {
    assert.equal(blockedBeforeInit.error.code, "tool_execution_failed");
    assert.match(blockedBeforeInit.error.message, /call `todo_write` first/i);
  }

  const readWhilePending = await toolRuntime.execute({
    id: "read-1",
    name: "read_test",
    input: {},
  }, context);
  assert.equal(readWhilePending.type, "success");

  const todoResult = await toolRuntime.execute({
    id: "todo-2",
    name: "todo_write",
    input: { markdown: "- [ ] step one\n- [ ] step two" },
  }, context);
  assert.equal(todoResult.type, "success");

  const firstWrite = await toolRuntime.execute({
    id: "write-2",
    name: "write_test",
    input: {},
  }, context);
  assert.equal(firstWrite.type, "success");
  assert.equal(handle.getSnapshot().requiresRefresh, true);

  const blockedUntilRefresh = await toolRuntime.execute({
    id: "write-3",
    name: "write_test",
    input: {},
  }, context);
  assert.equal(blockedUntilRefresh.type, "error");
  if (blockedUntilRefresh.type === "error") {
    assert.equal(blockedUntilRefresh.error.code, "tool_execution_failed");
    assert.match(blockedUntilRefresh.error.message, /todo list is stale/i);
  }
});
