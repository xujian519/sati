import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { GatewayEvent } from "../../src/gateway/index.js";
import { getPilotConfigFilePath } from "../../src/pilot/index.js";
import {
  createAgentProjectSessionStorage,
  JsonlTranscriptWriter,
} from "../../src/session/index.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelCapabilities,
  ModelRuntime,
} from "../../src/model/index.js";
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

    const { gateway, dispose } = createLocalGateway({
      projectRoot: defaultProject,
      pilotHome,
      env: { ANTHROPIC_API_KEY: "anthropic-key" },
    });
    try {
      const first = await gateway.listSessions({ projectKey: firstProject });
      const second = await gateway.listSessions({ projectKey: secondProject });

      assert.deepEqual(first.sessions.map((session) => session.sessionId), ["first-session"]);
      assert.deepEqual(second.sessions.map((session) => session.sessionId), ["second-session"]);
      assert.equal(first.sessions[0]?.cwd, firstProject);
      assert.equal(second.sessions[0]?.cwd, secondProject);
    } finally {
      dispose();
    }
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

    const { gateway, dispose } = createLocalGateway({
      projectRoot,
      pilotHome,
      env: { ANTHROPIC_API_KEY: "anthropic-key" },
    });
    try {
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
      dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway rehydrates cached sessions from memory after config reload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-local-gateway-config-reload-"));
  try {
    const pilotHome = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const configPath = getPilotConfigFilePath(pilotHome);
    const requests: CanonicalModelRequest[] = [];

    await writeJson(configPath, makeGlobalConfig("anthropic-main/claude-sonnet-4-5"));
    const { gateway, dispose } = createLocalGateway({
      projectRoot,
      pilotHome,
      env: {
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "openai-key",
      },
      __testModelFactory: (snapshot) => createRecordingModel(snapshot, requests),
    });
    try {
      const sessionKey = "cli:project=reload:session";
      const firstEvents = await collectGatewayEvents(gateway.submitTurn({
        sessionKey,
        channelKey: "cli",
        projectKey: projectRoot,
        message: "first message",
      }));
      assert.ok(firstEvents.some((event) => event.type === "turn_completed" && event.finishReason === "completed"));

      const storage = createAgentProjectSessionStorage({
        projectRoot,
        pilotHome,
        sessionId: sessionKey,
      });
      await writeFile(storage.transcriptPath, "", "utf8");

      await writeJson(configPath, makeGlobalConfig("openai-main/gpt-5.1"));
      const reload = await gateway.reloadConfig?.();
      assert.equal(reload?.reloaded, true);

      const secondEvents = await collectGatewayEvents(gateway.submitTurn({
        sessionKey,
        channelKey: "cli",
        projectKey: projectRoot,
        message: "second message",
      }));
      assert.ok(secondEvents.some((event) => event.type === "turn_completed" && event.finishReason === "completed"));

      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.provider, "anthropic-main");
      assert.equal(requests[0]?.model, "claude-sonnet-4-5");
      assert.equal(requests[1]?.provider, "openai-main");
      assert.equal(requests[1]?.model, "gpt-5.1");
      assert.ok(
        requests[1]?.messages.some((message) => messageText(message).includes("first message")),
        "expected second turn to keep the prior in-memory transcript after reload",
      );
    } finally {
      dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway only reloads cached sessions for the project whose plugins changed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-local-gateway-project-plugin-watch-"));
  try {
    const pilotHome = path.join(root, "home");
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    await writeJson(getPilotConfigFilePath(pilotHome), makeGlobalConfig("anthropic-main/claude-sonnet-4-5"));

    const { gateway, dispose } = createLocalGateway({
      projectRoot: projectA,
      pilotHome,
      env: {
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "openai-key",
      },
      __testModelFactory: (snapshot) => createRecordingModel(snapshot, []),
    });
    try {
      const sessionA = "cli:project=watch:a";
      const sessionB = "cli:project=watch:b";
      const initialA = await collectGatewayEvents(gateway.submitTurn({
        sessionKey: sessionA,
        channelKey: "cli",
        projectKey: projectA,
        message: "before plugin",
      }));
      const initialB = await collectGatewayEvents(gateway.submitTurn({
        sessionKey: sessionB,
        channelKey: "cli",
        projectKey: projectB,
        message: "before plugin",
      }));
      assert.ok(initialA.some((event) => event.type === "turn_completed" && event.finishReason === "completed"));
      assert.ok(initialB.some((event) => event.type === "turn_completed" && event.finishReason === "completed"));

      await writeJson(path.join(projectA, ".pilotdeck", "plugins", "blocker", "plugin.json"), {
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
      await waitForWatchDebounce();

      const afterA = await collectGatewayEvents(gateway.submitTurn({
        sessionKey: sessionA,
        channelKey: "cli",
        projectKey: projectA,
        message: "after plugin",
      }));
      const afterB = await collectGatewayEvents(gateway.submitTurn({
        sessionKey: sessionB,
        channelKey: "cli",
        projectKey: projectB,
        message: "after plugin",
      }));

      assert.ok(afterA.some((event) => event.type === "turn_completed" && event.finishReason === "model_error"));
      assert.ok(afterB.some((event) => event.type === "turn_completed" && event.finishReason === "completed"));
    } finally {
      dispose();
    }
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

async function collectGatewayEvents(stream: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeGlobalConfig(agentModel: string): {
  schemaVersion: number;
  agent: { model: string };
  model: ReturnType<typeof validModelConfig>;
} {
  return {
    schemaVersion: 1,
    agent: { model: agentModel },
    model: validModelConfig(),
  };
}

function createRecordingModel(
  snapshot: { config: { agent: { model: { provider: string; model: string } } } },
  requests: CanonicalModelRequest[],
): ModelRuntime {
  const active = snapshot.config.agent.model;
  return {
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: `reply:${active.provider}/${active.model}` };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      throw new Error("complete() not used in create-local-gateway tests");
    },
    getCapabilities(): ModelCapabilities {
      return {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: true,
        supportsThinking: false,
        supportsJsonSchema: true,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 200_000,
        maxOutputTokens: 8_192,
      };
    },
  };
}

function messageText(message: CanonicalModelRequest["messages"][number]): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function waitForWatchDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 750));
}
