#!/usr/bin/env node
/**
 * Smoke test: connect to the running PolitDeck Gateway server via the same
 * `RemoteGateway` path the TUI uses, run one turn, dump every event we see.
 * If this prints a `turn_completed`, the entire wire (WS frames →
 * SessionRouter → AgentSession → AgentLoop → ModelRuntime → yeysai) is healthy.
 */
import { connectRemoteGatewayIfAvailable } from "../dist/src/gateway/index.js";

const gateway = await connectRemoteGatewayIfAvailable({ timeoutMs: 1000 });
if (!gateway) {
  console.error("No gateway available — start `politdeck server` first.");
  process.exit(1);
}

const sessionKey = `cli:project=${process.cwd()}:smoke-${Date.now()}`;
console.log(`session: ${sessionKey}`);
console.log(`message: "Reply with exactly: PolitDeck E2E OK"`);
console.log("---");

let turnCompleted = false;
let assistantText = "";
const t0 = Date.now();
let deltaCount = 0;
for await (const event of gateway.submitTurn({
  sessionKey,
  channelKey: "cli",
  message: "Count from 1 to 8 with each number on its own line.",
})) {
  if (event.type === "assistant_text_delta" || event.type === "text_delta") {
    const chunk = event.delta ?? event.text ?? "";
    deltaCount += 1;
    const dt = (Date.now() - t0).toString().padStart(4, " ");
    console.log(`[+${dt}ms] delta#${deltaCount} (${chunk.length}ch) ${JSON.stringify(chunk)}`);
    assistantText += chunk;
  } else if (event.type === "turn_completed") {
    turnCompleted = true;
    console.log(`\n--- turn_completed (finishReason=${event.finishReason ?? "?"}) ---`);
  } else if (event.type === "error") {
    console.log(`\n[error] ${event.code}: ${event.message}`);
  } else {
    console.log(`[${event.type}]`);
  }
}

await gateway.closeSession({ sessionKey });

if (!turnCompleted) {
  console.error("Turn never completed.");
  process.exit(1);
}
console.log(`\nassistantText: ${assistantText.length} chars`);
process.exit(0);
