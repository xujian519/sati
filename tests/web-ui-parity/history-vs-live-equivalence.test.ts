/**
 * Verifies that `read_session_messages` (history) and the
 * `applyWebGatewayEvent` reducer (live) produce equivalent assistant text
 * messages for a turn that contains a single text reply.
 *
 * Normalization: id / createdAt / source are stripped so the comparison
 * focuses on observable content.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWebGatewayEvent,
  createWebMessageReducerState,
  type WebGatewayEvent,
  type WebMessage,
} from "../../src/web/client/index.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import { createProjectId } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

function normalize(message: WebMessage): {
  role: string;
  kind: string;
  text?: string;
  toolCallId?: string;
  ok?: boolean;
} {
  return {
    role: message.role,
    kind: message.kind,
    text: message.text,
    toolCallId: message.toolCallId,
    ok: message.ok,
  };
}

test("history reader and live reducer agree on a single text turn", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-equiv-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:equiv";
  const projectId = createProjectId(projectRoot);
  const chatDir = join(pilotHome, "projects", projectId, "chats");
  mkdirSync(chatDir, { recursive: true });

  // History: stored transcript with user input + assistant reply.
  const transcript = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-01-01T00:00:00.500Z",
      message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-01-01T00:00:01.000Z",
      result: {
        type: "success",
        sessionId: sessionKey,
        turnId: "turn-1",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    },
  ];
  writeFileSync(
    join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`),
    transcript.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );

  try {
    const historyResult = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );

    // Live: same turn replayed as Gateway events.
    const liveEvents: WebGatewayEvent[] = [
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "hello " },
      { type: "assistant_text_delta", text: "world" },
      {
        type: "turn_completed",
        usage: {},
        finishReason: "completed",
      },
    ];
    let state = createWebMessageReducerState();
    for (const event of liveEvents) {
      state = applyWebGatewayEvent(state, event, {
        sessionKey,
        projectKey: undefined,
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      });
    }

    // Compare assistant messages produced by both paths.
    const historyAssistant = historyResult.messages
      .filter((m) => m.role === "assistant")
      .map(normalize);
    const liveAssistant = state.messages
      .filter((m) => m.role === "assistant")
      .map(normalize);

    assert.deepEqual(historyAssistant, liveAssistant, "assistant projections must match");

    // History also includes the user message — this is intentional.
    const userMessages = historyResult.messages
      .filter((m) => m.role === "user")
      .map(normalize);
    assert.deepEqual(userMessages, [
      { role: "user", kind: "text", text: "ping", toolCallId: undefined, ok: undefined },
    ]);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
