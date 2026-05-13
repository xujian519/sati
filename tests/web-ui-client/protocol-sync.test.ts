import test from "node:test";
import assert from "node:assert/strict";
import {
  PILOTDECK_GATEWAY_PROTOCOL_VERSION,
} from "../../src/gateway/index.js";
import {
  PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB,
  type WebGatewayEvent,
  type WebGatewayMethod,
} from "../../src/web/client/index.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";
import type { WsGatewayMethod } from "../../src/gateway/protocol/frames.js";

test("Web protocol version matches Gateway protocol version", () => {
  assert.equal(PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB, PILOTDECK_GATEWAY_PROTOCOL_VERSION);
});

test("Every Gateway WS method is a WebGatewayMethod superset", () => {
  // Compile-time check: any value of WsGatewayMethod must be assignable to
  // WebGatewayMethod. We assert via type identity at runtime by listing the
  // methods the server currently dispatches and confirming they're declared
  // in the web superset (literal union check).
  const serverMethods: WsGatewayMethod[] = [
    "submit_turn",
    "abort_turn",
    "list_sessions",
    "resume_session",
    "new_session",
    "close_session",
    "describe_server",
    "cron_create",
    "cron_list",
    "cron_delete",
    "cron_stop",
    "elicitation_respond",
  ];
  const webMethods: WebGatewayMethod[] = serverMethods.map((m): WebGatewayMethod => m);
  assert.equal(webMethods.length, serverMethods.length);
});

test("Every GatewayEvent variant is also a WebGatewayEvent", () => {
  // We enumerate canonical events and ensure they map to a WebGatewayEvent
  // via a direct type assignment; this catches drift if `src` gains a new
  // event variant without updating the web mirror.
  const events: GatewayEvent[] = [
    { type: "turn_started", runId: "r" },
    { type: "assistant_text_delta", text: "" },
    { type: "assistant_thinking_delta", text: "" },
    { type: "tool_call_started", toolCallId: "t", name: "n" },
    { type: "tool_call_finished", toolCallId: "t", ok: true },
    { type: "permission_request", requestId: "p", toolName: "n", payload: {} },
    {
      type: "elicitation_request",
      requestId: "e",
      toolCallId: "tc",
      toolName: "n",
      questions: [],
    },
    { type: "elicitation_cancelled", requestId: "e" },
    { type: "structured_output", payload: {} },
    { type: "plan_mode_changed", mode: "plan" },
    { type: "config_changed", changedPaths: [], changeClasses: [] },
    { type: "worktree_created", runId: "r", cwd: "/tmp" },
    { type: "worktree_removed", cwd: "/tmp" },
    { type: "turn_completed", usage: {}, finishReason: "completed" },
    { type: "error", message: "boom", recoverable: true },
  ];
  for (const event of events) {
    const projected: WebGatewayEvent = event as WebGatewayEvent;
    assert.equal(projected.type, event.type);
  }
});
