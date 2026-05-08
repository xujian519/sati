import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { getPolitConfigFilePath, getPolitProjectConfigFilePath } from "../../src/polit/index.js";
import {
  createAgentProjectSessionStorage,
  JsonlTranscriptWriter,
} from "../../src/session/index.js";
import { validAgentConfig, validModelConfig } from "../model/helpers.js";

test("createLocalGateway lists sessions from the requested project only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-local-gateway-"));
  try {
    const politHome = path.join(root, "home");
    const defaultProject = path.join(root, "default-project");
    const firstProject = path.join(root, "first-project");
    const secondProject = path.join(root, "second-project");

    await writeJson(getPolitConfigFilePath(politHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });
    await writeJson(getPolitProjectConfigFilePath(firstProject), {
      agent: {
        model: "anthropic-main/claude-sonnet-4-5",
      },
    });
    await writeJson(getPolitProjectConfigFilePath(secondProject), {
      agent: {
        model: "openai-main/gpt-5.1",
      },
    });
    await writeSession({
      projectRoot: firstProject,
      politHome,
      sessionId: "first-session",
      prompt: "First project prompt",
    });
    await writeSession({
      projectRoot: secondProject,
      politHome,
      sessionId: "second-session",
      prompt: "Second project prompt",
    });

    const gateway = createLocalGateway({
      projectRoot: defaultProject,
      politHome,
      env: { ANTHROPIC_API_KEY: "anthropic-key" },
    });

    const first = await gateway.listSessions({ projectKey: firstProject });
    const second = await gateway.listSessions({ projectKey: secondProject });

    assert.deepEqual(first.sessions.map((session) => session.sessionId), ["first-session"]);
    assert.deepEqual(second.sessions.map((session) => session.sessionId), ["second-session"]);
    assert.equal(first.sessions[0]?.cwd, firstProject);
    assert.equal(second.sessions[0]?.cwd, secondProject);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSession(options: {
  projectRoot: string;
  politHome: string;
  sessionId: string;
  prompt: string;
}): Promise<void> {
  const storage = createAgentProjectSessionStorage(options);
  const writer = new JsonlTranscriptWriter({ path: storage.transcriptPath });
  await writer.recordAcceptedInput(options.sessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: options.prompt }] },
  ]);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
