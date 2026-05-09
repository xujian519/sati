import test from "node:test";
import assert from "node:assert/strict";
import { HookRuntime } from "../../src/extension/index.js";
import { LifecycleRuntime } from "../../src/lifecycle/index.js";
import { createPilotDeckTestTool, createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";
import type { PilotDeckHooksSettings } from "../../src/extension/index.js";

test("PreToolUse hook can update tool input before execution", async () => {
  const settings: PilotDeckHooksSettings = {
    PreToolUse: [
      {
        matcher: "echo",
        hooks: [
          {
            type: "command",
            command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{value:'new'}}}))"`,
          },
        ],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));
  const seenInputs: unknown[] = [];
  const tool = createPilotDeckTestTool({
    name: "echo",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
    execute: async (input) => {
      seenInputs.push(input);
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool], lifecycle });

  const result = await toolRuntime.execute({ id: "call-1", name: "echo", input: { value: "old" } }, context);

  assert.equal(result.type, "success");
  assert.deepEqual(seenInputs, [{ value: "new" }]);
});

test("PermissionRequest hook can allow a side-effecting tool without UI prompt", async () => {
  const settings: PilotDeckHooksSettings = {
    PermissionRequest: [
      {
        matcher: "write_file",
        hooks: [
          {
            type: "command",
            command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}))"`,
          },
        ],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));
  const tool = createPilotDeckTestTool({ name: "write_file", readOnly: false, kind: "filesystem" });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool], canPrompt: false, lifecycle });

  const result = await toolRuntime.execute({ id: "call-1", name: "write_file", input: {} }, context);

  assert.equal(result.type, "success");
});

test("PostToolUse hook blocking output is preserved as lifecycle metadata", async () => {
  const settings: PilotDeckHooksSettings = {
    PostToolUse: [
      {
        matcher: "read_file",
        hooks: [{ type: "command", command: `node -e "console.log(JSON.stringify({continue:false,stopReason:'blocked'}))"` }],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));
  const tool = createPilotDeckTestTool({ name: "read_file" });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({ tools: [tool], lifecycle });

  const result = await toolRuntime.execute({ id: "call-1", name: "read_file", input: {} }, context);

  assert.equal(result.type, "success");
  assert.deepEqual(result.metadata?.lifecycle, {
    blocked: { reason: "blocked", stopReason: "blocked" },
    additionalContext: [],
    updatedMcpToolOutput: undefined,
  });
});
