import test from "node:test";
import assert from "node:assert/strict";
import type { PilotDeckPermissionAuditRecord, PilotDeckToolAuditRecord } from "../../src/tool/index.js";
import { PilotDeckToolRuntimeError, toCanonicalToolResultBlock } from "../../src/tool/index.js";
import { createPilotDeckTestTool, createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("returns a standard error result for unknown tools", async () => {
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture();

  const result = await toolRuntime.execute({ id: "call-1", name: "missing", input: {} }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "tool_not_found");
  }
});

test("returns invalid_tool_input before execution", async () => {
  let executed = false;
  const tool = createPilotDeckTestTool({
    name: "search",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: { query: { type: "string" } },
    },
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "bad" }] };
    },
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool] });

  const result = await toolRuntime.execute({ id: "call-1", name: "search", input: {} }, context);

  assert.equal(executed, false);
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "invalid_tool_input");
  }
});

test("returns permission_required when a prompt is needed without UI", async () => {
  const tool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool], canPrompt: false });

  const result = await toolRuntime.execute({ id: "call-1", name: "write_file", input: {} }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "permission_required");
  }
});

test("executes allowed tools and maps result to canonical tool_result", async () => {
  const tool = createPilotDeckTestTool({
    name: "read_file",
    readOnly: true,
    execute: async () => ({ content: [{ type: "json", value: { ok: true } }] }),
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool] });

  const result = await toolRuntime.execute({ id: "call-1", name: "read_file", input: {} }, context);
  const block = toCanonicalToolResultBlock(result);

  assert.equal(result.type, "success");
  assert.equal(block.type, "tool_result");
  assert.equal(block.toolCallId, "call-1");
  assert.equal(block.isError, undefined);
  assert.equal(block.content[0]?.type, "text");
  assert.equal(block.content[0]?.text, "{\"ok\":true}");
});

test("normalizes execution throws", async () => {
  const tool = createPilotDeckTestTool({
    name: "boom",
    execute: async () => {
      throw new PilotDeckToolRuntimeError("unsupported_tool", "Not supported.");
    },
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool] });

  const result = await toolRuntime.execute({ id: "call-1", name: "boom", input: {} }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "unsupported_tool");
  }
});

test("records permission and tool audit records", async () => {
  const permissionRecords: PilotDeckPermissionAuditRecord[] = [];
  const toolRecords: PilotDeckToolAuditRecord[] = [];
  const tool = createPilotDeckTestTool({ name: "read_file" });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [tool],
    auditRecorder: {
      recordPermission: (record) => {
        permissionRecords.push(record);
      },
      recordTool: (record) => {
        toolRecords.push(record);
      },
    },
  });

  await toolRuntime.execute({ id: "call-1", name: "read_file", input: {} }, context);

  assert.equal(permissionRecords.length, 1);
  assert.equal(toolRecords.length, 1);
  assert.equal(permissionRecords[0]?.toolName, "read_file");
  assert.equal(toolRecords[0]?.status, "success");
});

test("truncates oversized result content", async () => {
  const tool = createPilotDeckTestTool({
    name: "read_file",
    maxResultBytes: 20,
    execute: async () => ({ content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }] }),
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool] });

  const result = await toolRuntime.execute({ id: "call-1", name: "read_file", input: {} }, context);

  assert.equal(result.type, "success");
  assert.equal(result.metadata?.truncated, true);
});
