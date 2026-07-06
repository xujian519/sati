import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlanTodoStateManager } from "../../src/agent/runtime/PlanTodoState.js";
import { createTodoWriteTool, parseTodoMarkdown } from "../../src/tool/builtin/todoWrite.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function createContext(sessionId = "session-1"): PilotDeckToolRuntimeContext {
  const planTodo = createPlanTodoStateManager().forSession(sessionId);
  return {
    sessionId,
    turnId: "turn-1",
    cwd: "/tmp/workspace",
    permissionMode: "default",
    permissionContext: {
      cwd: "/tmp/workspace",
      mode: "default",
      additionalWorkingDirectories: [],
      bypassAvailable: false,
      canPrompt: false,
      rules: { allow: [], ask: [], deny: [] },
    },
    planTodo,
  };
}

describe("todo_write", () => {
  it("keeps markdown checklist parsing compatible", () => {
    assert.deepEqual(parseTodoMarkdown("- [x] Done\n- [ ] Next\n- [ ] Later"), [
      { id: "todo-1", content: "Done", status: "completed" },
      { id: "todo-2", content: "Next", status: "in_progress" },
      { id: "todo-3", content: "Later", status: "pending" },
    ]);
  });

  it("writes and reads structured todos", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    const write = await tool.execute({
      todos: [
        { id: "inspect", content: "Inspect current implementation", status: "completed" },
        { id: "patch", content: "Patch editable todo support", status: "in_progress", priority: "high" },
      ],
      reason: "initial editable plan",
    }, context);

    assert.ok(write.data);
    assert.equal(write.data.mode, "structured");
    assert.equal(write.data.merge, false);
    assert.equal(write.data.reason, "initial editable plan");
    assert.deepEqual(write.data.todos, [
      { id: "inspect", content: "Inspect current implementation", status: "completed" },
      { id: "patch", content: "Patch editable todo support", status: "in_progress", priority: "high" },
    ]);

    const read = await tool.execute({}, context);
    assert.ok(read.data);
    assert.equal(read.data.mode, "read");
    assert.deepEqual(read.data.todos, write.data.todos);
  });

  it("merges structured todo updates by id and appends discovered work", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    await tool.execute({
      todos: [
        { id: "inspect", content: "Inspect current implementation", status: "completed" },
        { id: "patch", content: "Patch editable todo support", status: "in_progress" },
      ],
    }, context);

    const merged = await tool.execute({
      merge: true,
      reason: "found verification gap",
      todos: [
        { id: "patch", content: "Patch editable todo support", status: "completed" },
        { id: "verify", content: "Run todo workflow tests", status: "in_progress" },
      ],
    }, context);

    assert.ok(merged.data);
    assert.equal(merged.data.mode, "structured");
    assert.equal(merged.data.merge, true);
    assert.deepEqual(merged.data.todos, [
      { id: "inspect", content: "Inspect current implementation", status: "completed" },
      { id: "patch", content: "Patch editable todo support", status: "completed" },
      { id: "verify", content: "Run todo workflow tests", status: "in_progress" },
    ]);
  });

  it("supports cancelled structured todos", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    const result = await tool.execute({
      todos: [
        { id: "obsolete", content: "Use markdown-only updates", status: "cancelled" },
        { id: "structured", content: "Use structured updates", status: "in_progress" },
      ],
    }, context);

    assert.ok(result.data);
    assert.equal(result.data.todos[0]?.status, "cancelled");
    assert.equal(context.planTodo?.getSnapshot().todos[0]?.status, "cancelled");
  });
});
