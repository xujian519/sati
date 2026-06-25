import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { RouterDecision } from "../../../src/router/index.js";
import {
  ToolRegistry,
  createAskUserQuestionTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createTodoWriteTool,
} from "../../../src/tool/index.js";

const userMessage: CanonicalMessage = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

function config(canPrompt = true): AgentRuntimeConfig {
  const cwd = process.cwd();
  return {
    provider: "test",
    model: "test-model",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, canPrompt }),
  };
}

function decision(): RouterDecision {
  return {
    provider: "test",
    model: "test-model",
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "fallback",
    mutations: {},
  };
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(createAskUserQuestionTool());
  tools.register(createEnterPlanModeTool());
  tools.register(createExitPlanModeTool());
  tools.register(createTodoWriteTool());
  return tools;
}

function dependencies(captureTools: (names: string[]) => void): AgentRuntimeDependencies {
  return {
    router: {
      decide: async ({ request }: { request: CanonicalModelRequest }) => {
        captureTools(request.tools?.map((tool) => tool.name) ?? []);
        return decision();
      },
      execute: async function* (_decision: RouterDecision, _request: CanonicalModelRequest) {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* (_request: CanonicalModelRequest) {},
    },
    tools: {
      registry: registry(),
      scheduler: { executeAll: async () => [] },
    },
    context: {
      prepareForModel: async (input) => ({
        messages: input.messages,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
    },
  };
}

async function drain(loop: AgentLoop, canPrompt: boolean): Promise<void> {
  for await (const _event of loop.run({
    sessionId: "s",
    turnId: "t",
    messages: [userMessage],
    maxTurns: 1,
    canPrompt,
    allowPlanModeTools: true,
  })) {
    // Drain the loop.
  }
}

test("prompt-disabled turns hide interactive tools from the model request", async () => {
  let toolNames: string[] = [];
  const loop = new AgentLoop(config(true), dependencies((names) => { toolNames = names; }));

  await drain(loop, false);

  assert.deepEqual(new Set(toolNames).has("todo_write"), true);
  assert.deepEqual(new Set(toolNames).has("ask_user_question"), false);
  assert.deepEqual(new Set(toolNames).has("exit_plan_mode"), false);
  assert.deepEqual(new Set(toolNames).has("enter_plan_mode"), false);
});

test("prompt-enabled turns keep interactive tools available", async () => {
  let toolNames: string[] = [];
  const loop = new AgentLoop(config(true), dependencies((names) => { toolNames = names; }));

  await drain(loop, true);

  assert.deepEqual(new Set(toolNames).has("ask_user_question"), true);
  assert.deepEqual(new Set(toolNames).has("exit_plan_mode"), true);
  assert.deepEqual(new Set(toolNames).has("enter_plan_mode"), true);
});
