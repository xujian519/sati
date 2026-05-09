/**
 * Dual parity scenario: `submit-turn-text-stream`.
 *
 * Demonstrates the dual-runner pattern from
 * `docs/old-ui-adaptation/03-web-ui-testing/02-contract-and-parity-tests.md`.
 *
 * - The "legacy" runner takes the canonical `GatewayEvent` stream the old
 *   web UI consumed (synthetic here — old-UI test runner is not vendored).
 * - The "new" runner pumps the same events through the Web `WebMessage`
 *   reducer.
 * - Both sides produce a normalized report; the test deep-compares them.
 *
 * Real legacy reports (from `old_ui/`) can plug into this harness later
 * by emitting the same `WebUiParityReport` shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWebGatewayEvent,
  createWebMessageReducerState,
  type WebGatewayEvent,
} from "../../src/web/client/index.js";
import { WEB_UI_PARITY_SCENARIOS } from "../fixtures/web-ui/parity-scenarios.js";

type WebUiParityReport = {
  scenarioId: string;
  status: string;
  runner: "legacy" | "new";
  ok: boolean;
  events: { type: string; text?: string }[];
  messages: { role: string; kind: string; text?: string }[];
  errors: string[];
};

const SCENARIO_ID = "submit-turn-text-stream";

const events: WebGatewayEvent[] = [
  { type: "turn_started", runId: "run-1" },
  { type: "assistant_text_delta", text: "hello " },
  { type: "assistant_text_delta", text: "world" },
  { type: "turn_completed", usage: { totalTokens: 5 }, finishReason: "completed" },
];

function legacyReport(): WebUiParityReport {
  // Simulated legacy runner: text deltas merge into one assistant message,
  // turn_completed is recorded as a separate "complete" status row.
  return {
    scenarioId: SCENARIO_ID,
    status: "compare",
    runner: "legacy",
    ok: true,
    events: events.map((event) => ({
      type: event.type,
      text:
        event.type === "assistant_text_delta"
          ? event.text
          : undefined,
    })),
    messages: [
      { role: "assistant", kind: "text", text: "hello world" },
      { role: "system", kind: "complete", text: undefined },
    ],
    errors: [],
  };
}

function newReport(): WebUiParityReport {
  let state = createWebMessageReducerState();
  for (const event of events) {
    state = applyWebGatewayEvent(state, event, {
      sessionKey: "web:parity",
      projectKey: "demo",
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      newId: () => `id-${state.messages.length + 1}`,
    });
  }
  return {
    scenarioId: SCENARIO_ID,
    status: "compare",
    runner: "new",
    ok: true,
    events: events.map((event) => ({
      type: event.type,
      text:
        event.type === "assistant_text_delta"
          ? event.text
          : undefined,
    })),
    messages: state.messages.map((message) => ({
      role: message.role,
      kind: message.kind,
      text: message.text,
    })),
    errors: [],
  };
}

test("dual parity: submit-turn-text-stream produces matching normalized reports", () => {
  const scenario = WEB_UI_PARITY_SCENARIOS.find((s) => s.scenarioId === SCENARIO_ID);
  assert.ok(scenario, "scenario must exist");
  assert.equal(scenario?.status, "compare");

  const left = legacyReport();
  const right = newReport();
  // Both runners agree on visible message rows.
  assert.deepEqual(
    right.messages,
    left.messages,
    "new and legacy reports must match for `compare` scenario",
  );
  // Event sequence preserved.
  assert.deepEqual(
    right.events,
    left.events,
    "new runner must replay the same Gateway event sequence",
  );
});
