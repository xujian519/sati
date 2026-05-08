import assert from "node:assert/strict";
import { createAgentSession, type AgentEvent, type AgentRuntimeConfig } from "../../../src/agent/index.js";
import {
  AgentHookExecutor,
  AsyncHookRegistry,
  CallbackHookExecutor,
  CommandHookExecutor,
  HookExecutionEventBus,
  HookRuntime,
  HttpHookExecutor,
  PromptHookExecutor,
  type PolitDeckHookInput,
  type PolitDeckHooksSettings,
} from "../../../src/extension/index.js";
import { LifecycleRuntime } from "../../../src/lifecycle/index.js";
import { createModelRuntime, type CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { loadPolitConfig } from "../../../src/polit/index.js";
import { ToolRegistry, type PolitDeckToolDefinition } from "../../../src/tool/index.js";

const RUN_REAL_E2E = process.env.POLITDECK_RUN_REAL_AGENT_LIFECYCLE_E2E === "1";
const TOOL_NAME = "politdeck_lifecycle_smoke_tool";
const USER_PROMPT_MARKER = "USER_PROMPT_HOOK_MARKER_2026_05_08";
const PRE_TOOL_MARKER = "PRE_TOOL_HOOK_UPDATED_INPUT_2026_05_08";
const TOOL_RESULT_MARKER = "TOOL_RESULT_AFTER_HOOKS_2026_05_08";
const FINAL_MARKER = "REAL_AGENT_LIFECYCLE_HOOKS_OK";

if (!RUN_REAL_E2E) {
  console.error("Set POLITDECK_RUN_REAL_AGENT_LIFECYCLE_E2E=1 to run this real model smoke script.");
  process.exit(1);
}

const cwd = process.cwd();
const snapshot = loadPolitConfig();
const selectedModel = snapshot.config.agent.model;
const fallbackModel = snapshot.config.agent.fallbackModel;
const baseModelRuntime = createModelRuntime(snapshot.config.model);
const capabilities = baseModelRuntime.getCapabilities(selectedModel.provider, selectedModel.model);

assert.equal(
  capabilities.supportsToolUse,
  true,
  `Selected model ${selectedModel.provider}/${selectedModel.model} must support tool use for this smoke script.`,
);
assert.equal(
  capabilities.supportsStreaming,
  true,
  `Selected model ${selectedModel.provider}/${selectedModel.model} must support streaming for this smoke script.`,
);

const hookInputs: PolitDeckHookInput[] = [];
const toolExecutions: unknown[] = [];
const modelRequests: Array<{ index: number; toolChoice: CanonicalModelRequest["toolChoice"]; hasToolResult: boolean }> = [];
let nextId = 0;
let assistantText = "";
let sawToolCall = false;
let sawSuccessfulToolResult = false;
let finalTurnResultType: string | undefined;

const callbackExecutor = new CallbackHookExecutor();
callbackExecutor.register("record-session-start", ({ hookInput }) => {
  recordHook(hookInput);
});
callbackExecutor.register("add-user-prompt-context", ({ hookInput }) => {
  recordHook(hookInput);
  return {
    type: "sync",
    specific: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `The UserPromptSubmit smoke marker is ${USER_PROMPT_MARKER}.`,
    },
  };
});
callbackExecutor.register("update-tool-input", ({ hookInput }) => {
  recordHook(hookInput);
  return {
    type: "sync",
    specific: {
      hookEventName: "PreToolUse",
      updatedInput: {
        smokeInput: readSmokeInput(hookInput.toolInput) ?? "run",
        preToolMarker: PRE_TOOL_MARKER,
      },
    },
  };
});
callbackExecutor.register("allow-tool-permission", ({ hookInput }) => {
  recordHook(hookInput);
  return {
    type: "sync",
    specific: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  };
});
callbackExecutor.register("record-post-tool-use", ({ hookInput }) => {
  recordHook(hookInput);
  return {
    type: "sync",
    specific: {
      hookEventName: "PostToolUse",
      additionalContext: `PostToolUse observed ${TOOL_NAME}.`,
    },
  };
});
callbackExecutor.register("record-stop", ({ hookInput }) => {
  recordHook(hookInput);
  return {
    type: "sync",
    specific: {
      hookEventName: "Stop",
      additionalContext: "Stop hook completed for the real agent lifecycle smoke script.",
    },
  };
});
callbackExecutor.register("record-session-end", ({ hookInput }) => {
  recordHook(hookInput);
});

const hookSettings: PolitDeckHooksSettings = {
  SessionStart: [{ hooks: [{ type: "callback", name: "record-session-start" }] }],
  UserPromptSubmit: [{ hooks: [{ type: "callback", name: "add-user-prompt-context" }] }],
  PreToolUse: [{ matcher: TOOL_NAME, hooks: [{ type: "callback", name: "update-tool-input" }] }],
  PermissionRequest: [{ matcher: TOOL_NAME, hooks: [{ type: "callback", name: "allow-tool-permission" }] }],
  PostToolUse: [{ matcher: TOOL_NAME, hooks: [{ type: "callback", name: "record-post-tool-use" }] }],
  Stop: [{ hooks: [{ type: "callback", name: "record-stop" }] }],
  SessionEnd: [{ hooks: [{ type: "callback", name: "record-session-end" }] }],
};

const lifecycle = new LifecycleRuntime(
  new HookRuntime(
    hookSettings,
    new CommandHookExecutor(),
    new HookExecutionEventBus(),
    new AsyncHookRegistry(),
    new PromptHookExecutor(),
    new HttpHookExecutor(),
    new AgentHookExecutor(),
    callbackExecutor,
  ),
);

const registry = new ToolRegistry();
registry.register(createSmokeTool());

const permissionContext = createDefaultPermissionContext({
  cwd,
  mode: "default",
  canPrompt: false,
});
const config: AgentRuntimeConfig = {
  provider: selectedModel.provider,
  model: selectedModel.model,
  fallbackProvider: fallbackModel?.provider,
  fallbackModel: fallbackModel?.model,
  cwd,
  permissionMode: permissionContext.mode,
  permissionContext,
  systemPrompt: "You are executing a PolitDeck smoke test. Follow tool instructions exactly and copy requested markers verbatim.",
  toolChoice: { type: "tool", name: TOOL_NAME },
  maxOutputTokens: 384,
  temperature: 0,
  env: process.env,
  metadata: {
    configSnapshotVersion: snapshot.version,
    script: "run-real-agent-lifecycle-hooks",
  },
};

const session = createAgentSession({
  sessionId: "real-agent-lifecycle-hooks",
  config,
  dependencies: {
    model: {
      stream: (request, signal) => {
        const adjustedRequest = adjustToolChoice(request);
        modelRequests.push({
          index: modelRequests.length + 1,
          toolChoice: adjustedRequest.toolChoice,
          hasToolResult: hasToolResult(request),
        });
        return createModelRuntime(snapshot.config.model, { signal }).stream(adjustedRequest);
      },
    },
    tools: {
      registry,
    },
    lifecycle,
    uuid: createDeterministicId,
  },
});

const prompt = process.argv.slice(2).join(" ") || [
  `Call the tool named ${TOOL_NAME} exactly once with {"smokeInput":"run"}.`,
  "After the tool result is returned, answer in plain text only.",
  "Your final answer must include the exact marker from the UserPromptSubmit hook context.",
  "Your final answer must include the exact marker from the tool result.",
  `Your final answer must include this exact literal marker: ${FINAL_MARKER}.`,
].join(" ");

console.log(
  JSON.stringify(
    {
      type: "script_started",
      configSnapshotVersion: snapshot.version,
      provider: selectedModel.provider,
      model: selectedModel.model,
      fallbackProvider: fallbackModel?.provider,
      fallbackModel: fallbackModel?.model,
      toolName: TOOL_NAME,
      prompt,
    },
    null,
    2,
  ),
);

for await (const event of session.submit({ type: "text", text: prompt }, { turnId: "real-agent-lifecycle-hooks-turn", maxTurns: 3 })) {
  printEvent(event);
  if (event.type === "model_event" && event.event.type === "text_delta") {
    assistantText += event.event.text;
    process.stdout.write(event.event.text);
  }
  if (event.type === "tool_calls_detected" && event.calls.some((call) => call.name === TOOL_NAME)) {
    sawToolCall = true;
  }
  if (event.type === "tool_result" && event.result.toolName === TOOL_NAME && event.result.type === "success") {
    sawSuccessfulToolResult = true;
  }
  if (event.type === "turn_completed") {
    finalTurnResultType = event.result.type;
  }
}

assertSmokePassed();

console.log(
  `\n${JSON.stringify(
    {
      type: "script_completed",
      provider: selectedModel.provider,
      model: selectedModel.model,
      modelRequests,
      hookEvents: hookInputs.map((input) => input.hookEventName),
      toolExecutions,
      assistantText,
      session: session.snapshot(),
    },
    null,
    2,
  )}`,
);

function createSmokeTool(): PolitDeckToolDefinition {
  return {
    name: TOOL_NAME,
    description: [
      "Smoke-test tool for PolitDeck lifecycle hooks.",
      "When asked to run the lifecycle smoke test, call this tool exactly once with any JSON object.",
    ].join(" "),
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["smokeInput"],
      properties: {
        smokeInput: {
          type: "string",
          description: "Smoke-test input. Use the literal value run.",
        },
        preToolMarker: {
          type: "string",
          description: "Marker inserted by the PreToolUse hook.",
        },
      },
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async (input) => {
      toolExecutions.push(input);
      assertRecord(input, "PreToolUse must replace the model-provided tool input with an object.");
      assert.equal(input.preToolMarker, PRE_TOOL_MARKER, "PreToolUse hook did not update the tool input.");
      return {
        content: [
          {
            type: "text",
            text: `Tool hook smoke result: ${TOOL_RESULT_MARKER}. PreToolUse marker: ${input.preToolMarker}.`,
          },
        ],
        data: {
          toolResultMarker: TOOL_RESULT_MARKER,
          preToolMarker: input.preToolMarker,
        },
      };
    },
  };
}

function adjustToolChoice(request: CanonicalModelRequest): CanonicalModelRequest {
  if (hasToolResult(request)) {
    return {
      ...request,
      toolChoice: "none",
    };
  }
  return {
    ...request,
    toolChoice: { type: "tool", name: TOOL_NAME },
  };
}

function hasToolResult(request: CanonicalModelRequest): boolean {
  return request.messages.some((message) => message.content.some((block) => block.type === "tool_result"));
}

function readSmokeInput(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const smokeInput = (value as Record<string, unknown>).smokeInput;
  return typeof smokeInput === "string" ? smokeInput : undefined;
}

function recordHook(hookInput: PolitDeckHookInput): void {
  hookInputs.push(hookInput);
  console.error(`[hook] ${hookInput.hookEventName}`);
}

function createDeterministicId(): string {
  nextId += 1;
  return `real-agent-lifecycle-hooks-id-${nextId}`;
}

function assertSmokePassed(): void {
  assert.equal(finalTurnResultType, "success", "Agent loop did not complete successfully.");
  assert.equal(sawToolCall, true, `Model did not call ${TOOL_NAME}.`);
  assert.equal(sawSuccessfulToolResult, true, `${TOOL_NAME} did not return a successful tool result.`);
  assert.equal(toolExecutions.length, 1, `${TOOL_NAME} should execute exactly once.`);
  assertHookOrder([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ]);
  assert.match(assistantText, new RegExp(USER_PROMPT_MARKER, "u"), "Final model text did not include UserPromptSubmit hook context marker.");
  assert.match(assistantText, new RegExp(TOOL_RESULT_MARKER, "u"), "Final model text did not include tool result marker.");
  assert.match(assistantText, new RegExp(FINAL_MARKER, "u"), "Final model text did not include final smoke marker.");
}

function assertHookOrder(expectedEvents: string[]): void {
  let cursor = -1;
  const events = hookInputs.map((input) => input.hookEventName);
  for (const expected of expectedEvents) {
    const index = events.findIndex((event, candidateIndex) => candidateIndex > cursor && event === expected);
    assert.notEqual(index, -1, `Expected hook event ${expected} after index ${cursor}; observed ${events.join(", ")}`);
    cursor = index;
  }
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object", message);
  assert.notEqual(value, null, message);
  assert.equal(Array.isArray(value), false, message);
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "session_started":
      console.error(`[event] session_started session=${event.sessionId}`);
      return;
    case "turn_started":
      console.error(`[event] turn_started turn=${event.turnId}`);
      return;
    case "input_accepted":
      console.error(`[event] input_accepted messages=${event.messages.length}`);
      return;
    case "model_request_started":
      console.error(`[event] model_request_started provider=${event.provider} model=${event.model}`);
      return;
    case "model_event":
      console.error(`[event] model_event type=${event.event.type}`);
      if (event.event.type === "error") {
        console.error(JSON.stringify({ type: "model_error", error: event.event.error }, null, 2));
      }
      return;
    case "assistant_message":
      console.error(`[event] assistant_message blocks=${event.message.content.length}`);
      return;
    case "tool_calls_detected":
      console.error(`[event] tool_calls_detected count=${event.calls.length}`);
      return;
    case "tool_result":
      console.error(`[event] tool_result tool=${event.result.toolName} type=${event.result.type}`);
      return;
    case "tool_results_projected":
      console.error(`[event] tool_results_projected blocks=${event.message.content.length}`);
      return;
    case "mode_change_requested":
      console.error(`[event] mode_change_requested mode=${event.mode}`);
      return;
    case "turn_continued":
      console.error(`[event] turn_continued reason=${event.reason}`);
      return;
    case "turn_failed":
      console.error(`[event] turn_failed code=${event.error.code}`);
      return;
    case "turn_completed":
      console.error(`[event] turn_completed type=${event.result.type} stop=${event.result.stopReason}`);
      return;
  }
}
