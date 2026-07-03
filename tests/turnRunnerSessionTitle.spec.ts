import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../src/agent/index.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../src/agent/index.js";
import { TurnRunner } from "../src/agent/turn/TurnRunner.js";
import { SessionMetadataStore } from "../src/session/metadata/SessionMetadataStore.js";
import { InMemoryTranscriptWriter } from "../src/session/transcript/InMemoryTranscriptWriter.js";
import type { CanonicalMessage } from "../src/model/index.js";
import type { SessionTitleGenerator } from "../src/session/title/SessionTitleGenerator.js";

test("TurnRunner persists aiTitle for the first user message", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "s1" });
  const runner = createRunner({
    transcript,
    metadataStore,
    generator: async () => "Fix login flow",
  });

  await runTurn(runner, {
    sessionId: "s1",
    turnId: "t1",
    messages: [],
    input: { type: "text", text: "Please fix the login flow." },
  });

  const metadataEntries = transcript.entries.filter((entry) => entry.type === "session_metadata");
  assert.equal(metadataEntries.length, 1);
  assert.equal(metadataEntries[0]?.metadata.aiTitle, "Fix login flow");
  assert.equal(metadataEntries[0]?.turnId, "t1");
});

test("TurnRunner skips title generation when session has history", async () => {
  let calls = 0;
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "s1" });
  const runner = createRunner({
    transcript,
    metadataStore,
    generator: async () => {
      calls += 1;
      return "Should not write";
    },
  });

  await runTurn(runner, {
    sessionId: "s1",
    turnId: "t2",
    messages: [userMessage("Earlier prompt")],
    input: { type: "text", text: "Follow-up prompt" },
  });

  assert.equal(calls, 0);
  assert.equal(transcript.entries.some((entry) => entry.type === "session_metadata"), false);
});

test("TurnRunner does not overwrite existing manual or AI titles", async () => {
  for (const existing of ["title", "aiTitle"] as const) {
    let calls = 0;
    const transcript = new InMemoryTranscriptWriter();
    const metadataStore = new SessionMetadataStore({ transcript, sessionId: "s1" });
    if (existing === "title") {
      await metadataStore.saveTitle("Manual title", "pre");
    } else {
      await metadataStore.saveAiTitle("Existing AI title", "pre");
    }
    const runner = createRunner({
      transcript,
      metadataStore,
      generator: async () => {
        calls += 1;
        return "Should not write";
      },
    });

    await runTurn(runner, {
      sessionId: "s1",
      turnId: "t1",
      messages: [],
      input: { type: "text", text: "Please fix the login flow." },
    });

    assert.equal(calls, 0);
    const metadataEntries = transcript.entries.filter((entry) => entry.type === "session_metadata");
    assert.equal(metadataEntries.length, 1);
  }
});

test("TurnRunner skips auto title when disabled for subagent-style runners", async () => {
  let calls = 0;
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "s1" });
  const runner = createRunner({
    transcript,
    metadataStore,
    autoGenerateSessionTitle: false,
    generator: async () => {
      calls += 1;
      return "Should not write";
    },
  });

  await runTurn(runner, {
    sessionId: "s1",
    turnId: "t1",
    messages: [],
    input: { type: "text", text: "Please fix the login flow." },
  });

  assert.equal(calls, 0);
  assert.equal(transcript.entries.some((entry) => entry.type === "session_metadata"), false);
});

test("TurnRunner ignores title generator failures", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "s1" });
  const runner = createRunner({
    transcript,
    metadataStore,
    generator: async () => {
      throw new Error("boom");
    },
  });

  const result = await runTurn(runner, {
    sessionId: "s1",
    turnId: "t1",
    messages: [],
    input: { type: "text", text: "Please fix the login flow." },
  });

  assert.equal(result.result.type, "success");
  assert.equal(transcript.entries.some((entry) => entry.type === "session_metadata"), false);
});

function createRunner(options: {
  transcript: InMemoryTranscriptWriter;
  metadataStore: SessionMetadataStore;
  generator: SessionTitleGenerator;
  autoGenerateSessionTitle?: boolean;
}): TurnRunner {
  return new TurnRunner(
    createLoop(),
    options.transcript,
    undefined,
    () => new Date("2026-01-01T00:00:00.000Z"),
    undefined,
    { cwd: "/tmp/project", transcriptPath: "" },
    {
      metadataStore: options.metadataStore,
      sessionTitleGenerator: options.generator,
      autoGenerateSessionTitle: options.autoGenerateSessionTitle ?? true,
    },
  );
}

function createLoop(): AgentLoop {
  return {
    async *run(input: AgentLoopInput): AsyncGenerator<never, AgentLoopRunResult, unknown> {
      return {
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        messages: input.messages,
      };
    },
    snapshotFileState() {
      return {};
    },
  } as unknown as AgentLoop;
}

async function runTurn(
  runner: TurnRunner,
  options: Parameters<TurnRunner["run"]>[0],
): Promise<AgentLoopRunResult> {
  const iterator = runner.run(options);
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return next.value;
    }
  }
}

function userMessage(text: string): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}
