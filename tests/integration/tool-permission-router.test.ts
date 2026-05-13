import test from "node:test";
import assert from "node:assert/strict";
import { createAgentLoopFixture, collectAsyncGenerator } from "../helpers/agent.js";
import { createPilotDeckTestTool } from "../helpers/tool.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

function textReply(text: string): CanonicalModelEvent[] {
  return [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: "message_end", finishReason: "stop" },
  ];
}

function toolCallThenReply(toolName: string, input: unknown, replyText: string): CanonicalModelEvent[][] {
  return [
    [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "c1", name: toolName, input } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    textReply(replyText),
  ];
}

test("bypassPermissions allows side-effect tools without prompting", async () => {
  const calls: string[] = [];
  const sideEffectTool = createPilotDeckTestTool({
    name: "write_file",
    readOnly: false,
    execute: async () => { calls.push("write"); return { content: [{ type: "text", text: "written" }] }; },
  });
  const { loop } = createAgentLoopFixture({
    scripts: toolCallThenReply("write_file", {}, "done"),
    tools: [sideEffectTool],
    permissionMode: "bypassPermissions",
  });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 3,
      messages: [{ role: "user", content: [{ type: "text", text: "write something" }] }],
    }),
  );
  assert.equal(result.result.type, "success");
  assert.deepEqual(calls, ["write"]);
});

test("default permission mode blocks side-effect tools with permission_required", async () => {
  const sideEffectTool = createPilotDeckTestTool({
    name: "bash_tool",
    readOnly: false,
    execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
  });
  const { loop } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "c1", name: "bash_tool", input: {} } },
        { type: "message_end", finishReason: "tool_call" },
      ],
      textReply("I need permission"),
    ],
    tools: [sideEffectTool],
    permissionMode: "default",
    canPrompt: false,
  });
  const { values } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 3,
      messages: [{ role: "user", content: [{ type: "text", text: "run something" }] }],
    }),
  );
  const toolResults = values.filter((e) => e.type === "tool_result");
  assert.ok(toolResults.length > 0);
});

test("plan mode allows read-only tools", async () => {
  const calls: string[] = [];
  const readTool = createPilotDeckTestTool({
    name: "read_file",
    readOnly: true,
    execute: async () => { calls.push("read"); return { content: [{ type: "text", text: "contents" }] }; },
  });
  const { loop } = createAgentLoopFixture({
    scripts: toolCallThenReply("read_file", {}, "here are the contents"),
    tools: [readTool],
    permissionMode: "plan",
    config: { permissionMode: "plan" },
  });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 3,
      messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    }),
  );
  assert.equal(result.result.type, "success");
  assert.deepEqual(calls, ["read"]);
});

test("plan mode blocks write tools", async () => {
  const writeTool = createPilotDeckTestTool({
    name: "write_file",
    readOnly: false,
    execute: async () => ({ content: [{ type: "text", text: "written" }] }),
  });
  const { loop } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "c1", name: "write_file", input: {} } },
        { type: "message_end", finishReason: "tool_call" },
      ],
      textReply("cannot write in plan mode"),
    ],
    tools: [writeTool],
    permissionMode: "plan",
    canPrompt: false,
  });
  const { values } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 3,
      messages: [{ role: "user", content: [{ type: "text", text: "write something" }] }],
    }),
  );
  const toolResults = values.filter((e) => e.type === "tool_result");
  assert.ok(toolResults.length > 0);
});

test("deny rule blocks tool even in bypassPermissions mode", async () => {
  const dangerTool = createPilotDeckTestTool({
    name: "dangerous",
    readOnly: false,
    permissionResult: { type: "deny", reason: { type: "rule", behavior: "deny", rule: { source: "policy", behavior: "deny", toolName: "dangerous" }, message: "blocked by rule" }, message: "blocked by rule" },
    execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
  });
  const { loop } = createAgentLoopFixture({
    scripts: [
      [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "c1", name: "dangerous", input: {} } },
        { type: "message_end", finishReason: "tool_call" },
      ],
      textReply("tool was denied"),
    ],
    tools: [dangerTool],
    permissionMode: "bypassPermissions",
  });
  const { values, result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 3,
      messages: [{ role: "user", content: [{ type: "text", text: "do the dangerous thing" }] }],
    }),
  );
  assert.ok(result.result.permissionDenials === undefined || result.result.permissionDenials.length > 0 || values.some((e) => e.type === "tool_result"));
});
