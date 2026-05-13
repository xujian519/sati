import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { getPilotConfigFilePath, getPilotProjectConfigFilePath } from "../../src/pilot/index.js";
import {
  createAgentProjectSessionStorage,
  JsonlTranscriptWriter,
} from "../../src/session/index.js";
import { validAgentConfig, validModelConfig } from "../model/helpers.js";

test("createLocalGateway lists sessions from the requested project only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-local-gateway-"));
  try {
    const pilotHome = path.join(root, "home");
    const defaultProject = path.join(root, "default-project");
    const firstProject = path.join(root, "first-project");
    const secondProject = path.join(root, "second-project");

    await writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });
    await writeJson(getPilotProjectConfigFilePath(firstProject), {
      agent: {
        model: "anthropic-main/claude-sonnet-4-5",
      },
    });
    await writeJson(getPilotProjectConfigFilePath(secondProject), {
      agent: {
        model: "openai-main/gpt-5.1",
      },
    });
    await writeSession({
      projectRoot: firstProject,
      pilotHome,
      sessionId: "first-session",
      prompt: "First project prompt",
    });
    await writeSession({
      projectRoot: secondProject,
      pilotHome,
      sessionId: "second-session",
      prompt: "Second project prompt",
    });

    const { gateway } = createLocalGateway({
      projectRoot: defaultProject,
      pilotHome,
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

test("createLocalGateway loads project plugin hooks into submitted sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-local-gateway-plugin-"));
  try {
    const pilotHome = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const pluginRoot = path.join(projectRoot, ".pilotdeck", "plugins", "blocker");

    await writeJson(getPilotConfigFilePath(pilotHome), {
      schemaVersion: 1,
      agent: validAgentConfig(),
      model: validModelConfig(),
    });
    await writeJson(path.join(pluginRoot, "plugin.json"), {
      name: "blocker",
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "node -e \"console.log('{\\\"decision\\\":\\\"block\\\",\\\"reason\\\":\\\"plugin blocked\\\"}')\"",
              },
            ],
          },
        ],
      },
    });

    const { gateway } = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { ANTHROPIC_API_KEY: "anthropic-key" },
    });

    const events = [];
    for await (const event of gateway.submitTurn({
      sessionKey: "cli:project=test:plugin",
      channelKey: "cli",
      projectKey: projectRoot,
      message: "hello",
    })) {
      events.push(event);
    }

    assert.ok(events.some((event) => event.type === "turn_completed" && event.finishReason === "model_error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSession(options: {
  projectRoot: string;
  pilotHome: string;
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
