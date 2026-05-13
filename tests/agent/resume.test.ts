import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSessionWithStorage } from "../../src/agent/index.js";
import { resumeAgentSession, readTranscript } from "../../src/session/index.js";
import { createPilotDeckTestTool } from "../helpers/tool.js";
import { collectAsyncGenerator, createAgentLoopFixture } from "../helpers/agent.js";

test("resumeAgentSession rebuilds messages and replay events from project transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-agent-resume-"));
  try {
    const tool = createPilotDeckTestTool({ name: "lookup" });
    const fixture = createAgentLoopFixture({
      tools: [tool],
      scripts: [
        [
          { type: "message_start", role: "assistant" },
          { type: "text_delta", text: "stored" },
          { type: "message_end", finishReason: "stop" },
        ],
      ],
    });
    const { session, storage } = createAgentSessionWithStorage({
      sessionId: "session-1",
      config: fixture.config,
      dependencies: fixture.dependencies,
      projectStorage: {
        projectRoot: path.join(root, "repo"),
        pilotHome: path.join(root, "home"),
      },
    });

    await collectAsyncGenerator(session.submit({ type: "text", text: "hello" }, { turnId: "turn-1" }));
    assert.ok(storage?.transcriptPath);

    const resumed = await resumeAgentSession({
      sessionId: "session-1",
      config: fixture.config,
      dependencies: fixture.dependencies,
      projectStorage: {
        projectRoot: path.join(root, "repo"),
        pilotHome: path.join(root, "home"),
      },
    });
    const replay = await collectAsyncGenerator(resumed.session.replay());

    assert.equal(resumed.diagnostics.length, 0);
    assert.equal(resumed.session.snapshot().messages.length, 2);
    assert.ok(replay.values.some((event) => event.type === "input_accepted"));
    assert.ok(replay.values.some((event) => event.type === "assistant_message"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeAgentSession continues sequence from existing transcript without duplicates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-agent-resume-seq-"));
  try {
    const tool = createPilotDeckTestTool({ name: "lookup" });
    const scripts = () => [
      [
        { type: "message_start" as const, role: "assistant" as const },
        { type: "text_delta" as const, text: "reply" },
        { type: "message_end" as const, finishReason: "stop" as const },
      ],
    ];
    const projectStorage = {
      projectRoot: path.join(root, "repo"),
      pilotHome: path.join(root, "home"),
    };

    const fixture1 = createAgentLoopFixture({ tools: [tool], scripts: scripts() });
    const { session: session1, storage: storage1 } = createAgentSessionWithStorage({
      sessionId: "session-1",
      config: fixture1.config,
      dependencies: fixture1.dependencies,
      projectStorage,
    });
    await collectAsyncGenerator(session1.submit({ type: "text", text: "turn-1" }, { turnId: "t1" }));
    assert.ok(storage1?.transcriptPath);

    const preResume = await readTranscript(storage1.transcriptPath);
    const maxSeqBefore = Math.max(...preResume.entries.map((e) => e.sequence));

    const fixture2 = createAgentLoopFixture({ tools: [tool], scripts: scripts() });
    const resumed = await resumeAgentSession({
      sessionId: "session-1",
      config: fixture2.config,
      dependencies: fixture2.dependencies,
      projectStorage,
    });
    await collectAsyncGenerator(resumed.session.submit({ type: "text", text: "turn-2" }, { turnId: "t2" }));

    const postResume = await readTranscript(storage1.transcriptPath);
    const sequences = postResume.entries.map((e) => e.sequence);
    const uniqueSeqs = new Set(sequences);

    assert.equal(uniqueSeqs.size, sequences.length, "all sequence values must be unique after resume");
    assert.ok(
      Math.min(...postResume.entries.filter((e) => e.turnId === "t2").map((e) => e.sequence)) > maxSeqBefore,
      "resumed turn sequences must continue after existing max",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
