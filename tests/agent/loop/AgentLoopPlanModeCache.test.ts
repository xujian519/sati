import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/index.js";
import type { AgentRuntimeConfig, AgentRuntimeDependencies } from "../../../src/agent/index.js";
import { DefaultContextRuntime } from "../../../src/context/index.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext, type PermissionMode } from "../../../src/permission/index.js";
import {
  createBuiltinRegistry,
  SequentialToolScheduler,
  ToolRuntime,
} from "../../../src/tool/index.js";
import { PermissionRuntime } from "../../../src/permission/index.js";

const PLAN_SESSION_TOOLS = new Set(["enter_plan_mode", "exit_plan_mode"]);

test("default and plan requests keep system prompt and non-plan tool schemas stable", async () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "inspect plan mode" }] },
  ];

  const normal = await buildModelRequest("default", false, messages);
  const plan = await buildModelRequest("plan", true, messages);

  assert.equal(normal.systemPrompt, plan.systemPrompt);

  const normalTools = requireTools(normal);
  const planTools = requireTools(plan);
  const normalNonPlanTools = normalTools
    .filter((tool) => !PLAN_SESSION_TOOLS.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const planNonPlanTools = planTools
    .filter((tool) => !PLAN_SESSION_TOOLS.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(planNonPlanTools, normalNonPlanTools);
  assert.equal(planTools.some((tool) => tool.name === "enter_plan_mode"), true);
  assert.equal(planTools.some((tool) => tool.name === "exit_plan_mode"), true);

  const planMessageText = textBlocks(plan.messages.at(-1));
  assert.match(planMessageText, /Plan mode is active/);
  assert.match(planMessageText, /exit_plan_mode/);
  assert.equal(normal.messages.length, messages.length);
});

test("ordinary turns hide plan mode tools", async () => {
  const request = await buildModelRequest("default", false, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);

  const names = requireTools(request).map((tool) => tool.name);
  assert.equal(names.includes("enter_plan_mode"), false);
  assert.equal(names.includes("exit_plan_mode"), false);
});

async function buildModelRequest(
  permissionMode: PermissionMode,
  allowPlanModeTools: boolean,
  messages: CanonicalMessage[],
): Promise<CanonicalModelRequest> {
  const registry = createBuiltinRegistry({
    webSearch: false,
    webFetch: false,
    agent: false,
    structuredOutput: false,
    askUserQuestion: false,
  });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const cwd = "/workspace";
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "model",
    cwd,
    permissionMode,
    permissionContext: createDefaultPermissionContext({ cwd, mode: permissionMode }),
  };
  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide({ request }) {
        return {
          provider: request.provider,
          model: request.model,
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute() {},
      async *stream() {},
    },
    tools: {
      registry,
      scheduler: new SequentialToolScheduler(runtime),
    },
    context: new DefaultContextRuntime({
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    }),
    now: () => new Date("2026-06-23T00:00:00.000Z"),
  };
  const loop = new AgentLoop(config, dependencies);
  const createModelRequest = (loop as unknown as {
    createModelRequest(
      nextMessages: CanonicalMessage[],
      input: {
        sessionId: string;
        turnId: string;
        messages: CanonicalMessage[];
        allowPlanModeTools?: boolean;
      },
    ): Promise<CanonicalModelRequest>;
  }).createModelRequest.bind(loop);

  return createModelRequest(messages, {
    sessionId: "session-1",
    turnId: "turn-1",
    messages,
    allowPlanModeTools,
  });
}

function requireTools(request: CanonicalModelRequest): NonNullable<CanonicalModelRequest["tools"]> {
  assert.ok(request.tools);
  return request.tools;
}

function textBlocks(message: CanonicalMessage | undefined): string {
  return message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
}
