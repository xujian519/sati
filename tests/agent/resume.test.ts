import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSessionWithStorage } from "../../src/agent/index.js";
import { resumeAgentSession } from "../../src/session/index.js";
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
