import { createModelRuntime, type CanonicalModelEvent } from "../../../src/model/index.js";
import { loadPolitConfig } from "../../../src/polit/index.js";

const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PolitDeck streaming OK";

const snapshot = loadPolitConfig();
const { defaultProvider, defaultModel } = snapshot.config.model;
const runtime = createModelRuntime(snapshot.config.model);

const events: CanonicalModelEvent[] = [];
let text = "";

console.log(
  JSON.stringify(
    {
      type: "script_started",
      configSnapshotVersion: snapshot.version,
      provider: defaultProvider,
      model: defaultModel,
      prompt,
    },
    null,
    2,
  ),
);

for await (const event of runtime.stream({
  provider: defaultProvider,
  model: defaultModel,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ],
  maxOutputTokens: 128,
  temperature: 0,
  metadata: {
    configSnapshotVersion: snapshot.version,
    script: "stream-real-model",
  },
})) {
  events.push(event);
  printEvent(event);

  if (event.type === "text_delta") {
    text += event.text;
    process.stdout.write(event.text);
  }
}

console.log(
  `\n${JSON.stringify(
    {
      type: "script_completed",
      eventCount: events.length,
      text,
    },
    null,
    2,
  )}`,
);

function printEvent(event: CanonicalModelEvent): void {
  switch (event.type) {
    case "request_started":
      console.error(`[event] request_started provider=${event.provider} model=${event.model}`);
      return;
    case "message_start":
      console.error(`[event] message_start role=${event.role}`);
      return;
    case "text_delta":
      console.error(`[event] text_delta length=${event.text.length}`);
      return;
    case "thinking_delta":
      console.error(`[event] thinking_delta length=${event.text.length}`);
      return;
    case "tool_call_start":
      console.error(`[event] tool_call_start id=${event.id} name=${event.name}`);
      return;
    case "tool_call_delta":
      console.error(`[event] tool_call_delta id=${event.id} length=${event.delta.length}`);
      return;
    case "tool_call_end":
      console.error(`[event] tool_call_end id=${event.toolCall.id} name=${event.toolCall.name}`);
      return;
    case "message_end":
      console.error(`[event] message_end finishReason=${event.finishReason}`);
      return;
    case "usage":
      console.error(`[event] usage ${JSON.stringify(event.usage)}`);
      return;
    case "error":
      console.error(`[event] error ${JSON.stringify(event.error)}`);
      return;
  }
}
