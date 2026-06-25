import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime, createDefaultPermissionContext } from "../../src/permission/index.js";
import {
  ToolRegistry,
  ToolRuntime,
  createAskUserQuestionTool,
  createBashTool,
  type PilotDeckToolRuntimeContext,
} from "../../src/tool/index.js";

const cleanupCommand = "rm -rf /tmp_workspace/source.tar.gz /tmp_workspace/arxiv_source";

function context(mode: "default" | "bypassPermissions", canPrompt: boolean): PilotDeckToolRuntimeContext {
  const cwd = process.cwd();
  return {
    sessionId: "s",
    turnId: "t",
    cwd,
    permissionMode: mode,
    permissionContext: createDefaultPermissionContext({ cwd, mode, canPrompt }),
  };
}

test("permission asks are denied when prompts are disabled", async () => {
  const decision = await new PermissionRuntime().decide(
    createBashTool(),
    { command: cleanupCommand },
    context("default", false),
    "call-1",
  );

  assert.equal(decision.type, "deny");
  assert.match(decision.message, /prompts are disabled/);
});

test("bypassPermissions still allows asks when prompts are disabled", async () => {
  const decision = await new PermissionRuntime().decide(
    createBashTool(),
    { command: cleanupCommand },
    context("bypassPermissions", false),
    "call-1",
  );

  assert.equal(decision.type, "allow");
});

test("ask_user_question is blocked immediately when prompts are disabled", async () => {
  const registry = new ToolRegistry();
  registry.register(createAskUserQuestionTool());
  const runtime = new ToolRuntime(
    registry,
    new PermissionRuntime(),
    undefined,
    undefined,
  );

  const result = await runtime.execute({
    id: "call-1",
    name: "ask_user_question",
    input: {
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [
          { label: "yes", description: "Continue" },
          { label: "no", description: "Stop" },
        ],
      }],
    },
  }, context("bypassPermissions", false));

  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "unsupported_tool");
    assert.match(result.error.message, /prompts disabled/);
  }
});
