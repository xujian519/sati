import { createAgentSession, type AgentEvent, type AgentRuntimeConfig } from "../../../src/agent/index.js";
import { createModelRuntime } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { loadPolitConfig } from "../../../src/polit/index.js";
import { createBuiltinRegistry } from "../../../src/tool/index.js";
import { createRouterRuntime } from "../../../src/router/index.js";

const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PolitDeck agent loop OK";
const cwd = process.cwd();
const snapshot = loadPolitConfig();
const selectedModel = snapshot.config.agent.model;
const registry = createBuiltinRegistry();
const permissionContext = createDefaultPermissionContext({
  cwd,
  mode: "dontAsk",
});

const config: AgentRuntimeConfig = {
  provider: selectedModel.provider,
  model: selectedModel.model,
  cwd,
  permissionMode: permissionContext.mode,
  permissionContext,
  maxOutputTokens: 128,
  temperature: 0,
  metadata: {
    configSnapshotVersion: snapshot.version,
    script: "run-real-agent-loop",
  },
};

const modelRuntime = createModelRuntime(snapshot.config.model);
const routerRuntime = createRouterRuntime(
  snapshot.config.router ?? { scenarios: { default: selectedModel } },
  { modelRuntime },
);

const session = createAgentSession({
  sessionId: "real-agent-loop",
  config,
  dependencies: {
    router: routerRuntime,
    tools: {
      registry,
    },
    uuid: createDeterministicId,
  },
});

let nextId = 0;
let assistantText = "";

console.log(
  JSON.stringify(
    {
      type: "script_started",
      configSnapshotVersion: snapshot.version,
      provider: selectedModel.provider,
      model: selectedModel.model,
      prompt,
    },
    null,
    2,
  ),
);

for await (const event of session.submit({ type: "text", text: prompt }, { turnId: "real-agent-loop-turn", maxTurns: 3 })) {
  printEvent(event);
  if (event.type === "model_event" && event.event.type === "text_delta") {
    assistantText += event.event.text;
    process.stdout.write(event.event.text);
  }
}

console.log(
  `\n${JSON.stringify(
    {
      type: "script_completed",
      assistantText,
      session: session.snapshot(),
    },
    null,
    2,
  )}`,
);

function createDeterministicId(): string {
  nextId += 1;
  return `real-agent-loop-id-${nextId}`;
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
