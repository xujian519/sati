import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import type { AgentEvent } from "../../src/agent/index.js";
import type { PilotDeckToolResult } from "../../src/tool/protocol/result.js";

function toolResultEvent(toolCallId: string, text: string): AgentEvent {
  const result: PilotDeckToolResult = {
    type: "success",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
  return { type: "tool_result", sessionId: "s1", turnId: "t1", result };
}

const PERSIST_DIR = resolve(tmpdir(), "pilotdeck-tool-results");

test("mapAgentEvent: large output is persisted to disk", async () => {
  const bigText = Array.from({ length: 200 }, (_, i) => `line-${i}: ${"x".repeat(30)}`).join("\n");
  assert.ok(Buffer.byteLength(bigText) > 4096, "test input must exceed persist threshold");
  const event = toolResultEvent("tc-persist-large", bigText);
  const [result] = mapAgentEvent(event, "run-1");
  assert.equal(result.type, "tool_call_finished");
  if (result.type !== "tool_call_finished") return;
  assert.ok(result.resultPath, "large output should have a resultPath");
  assert.match(result.resultPath!, /tc-persist-large\.txt$/);

  await sleep(200);
  assert.ok(existsSync(result.resultPath!), "file should exist on disk");
  const content = readFileSync(result.resultPath!, "utf8");
  assert.equal(content, bigText);

  rmSync(result.resultPath!, { force: true });
});

test("mapAgentEvent: small output has no resultPath", () => {
  const event = toolResultEvent("tc-persist-small", "short output");
  const [result] = mapAgentEvent(event, "run-1");
  if (result.type !== "tool_call_finished") return;
  assert.equal(result.resultPath, undefined, "small output should not be persisted");
});

test("mapAgentEvent: resultBytes reflects actual byte length", () => {
  const text = "hello 你好 world";
  const event = toolResultEvent("tc-persist-bytes", text);
  const [result] = mapAgentEvent(event, "run-1");
  if (result.type !== "tool_call_finished") return;
  assert.equal(result.resultBytes, Buffer.byteLength(text, "utf-8"));
});
