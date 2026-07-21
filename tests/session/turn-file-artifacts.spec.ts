import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

test("TurnRunner emits and persists file artifacts before completing the turn", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-turn-artifacts-"));
  try {
    const result: AgentTurnResult = {
      type: "success",
      sessionId: "session-1",
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-07-21T10:00:00.000Z",
      completedAt: "2026-07-21T10:00:01.000Z",
    };
    const fakeLoop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        await writeFile(join(projectRoot, "result.xlsx"), "workbook");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages: input.messages };
      },
      snapshotFileState: () => ({}),
    } as unknown as AgentLoop;
    const transcript = new InMemoryTranscriptWriter();
    const runner = new TurnRunner(
      fakeLoop,
      transcript,
      undefined,
      () => new Date("2026-07-21T10:00:01.000Z"),
      undefined,
      { cwd: projectRoot, transcriptPath: "" },
    );

    const eventTypes: string[] = [];
    for await (const event of runner.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [],
      input: { type: "text", text: "Create a workbook" },
    })) {
      eventTypes.push(event.type);
    }

    assert.ok(eventTypes.indexOf("file_artifacts") > -1);
    assert.ok(eventTypes.indexOf("file_artifacts") < eventTypes.indexOf("turn_completed"));
    const artifactEntryIndex = transcript.entries.findIndex((entry) => entry.type === "file_artifacts");
    const resultEntryIndex = transcript.entries.findIndex((entry) => entry.type === "turn_result");
    assert.ok(artifactEntryIndex > -1);
    assert.ok(artifactEntryIndex < resultEntryIndex);
    const artifactEntry = transcript.entries[artifactEntryIndex];
    assert.equal(artifactEntry.type === "file_artifacts" ? artifactEntry.artifacts[0]?.path : undefined, "result.xlsx");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
