import test from "node:test";
import assert from "node:assert/strict";
import { createRouterRuntime } from "../../src/router/index.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";
import { PluginRuntime } from "../../src/extension/index.js";

class ScriptedModelRuntime implements ModelRuntime {
  readonly received: CanonicalModelRequest[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly scripts: CanonicalModelEvent[][]) {}

  async *stream(
    request: CanonicalModelRequest,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<CanonicalModelEvent> {
    this.received.push(request);
    this.signals.push(options.signal);
    const script = this.scripts.shift() ?? [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ];
    for (const event of script) {
      yield event;
    }
  }

  async complete(): Promise<CanonicalModelResponse> {
    throw new Error("not used in these tests");
  }

  getCapabilities() {
    return {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: false,
      supportsJsonSchema: true,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000,
    };
  }
  getMultimodal() { return { input: ["text" as const] }; }
}

const baseConfig: RouterConfig = {
  scenarios: {
    default: { id: "primary/main", provider: "primary", model: "main" },
  },
  zeroUsageRetry: { enabled: true, maxAttempts: 3 },
};

const baseRequest: CanonicalModelRequest = {
  provider: "ignored",
  model: "ignored",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

test("RouterRuntime decide selects default scenario", async () => {
  const modelRuntime = new ScriptedModelRuntime([]);
  const router = createRouterRuntime(baseConfig, { modelRuntime });
  const decision = await router.decide({
    request: baseRequest,
    sessionId: "s1",
    isMainAgent: true,
  });
  assert.equal(decision.scenarioType, "default");
  assert.equal(decision.provider, "primary");
  assert.equal(decision.model, "main");
});

test("RouterRuntime execute streams successful events and applies decision provider/model", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const router = createRouterRuntime(baseConfig, { modelRuntime });
  const events: CanonicalModelEvent[] = [];
  for await (const event of router.stream(baseRequest, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
  })) {
    events.push(event);
  }
  assert.equal(modelRuntime.received[0]?.provider, "primary");
  assert.equal(modelRuntime.received[0]?.model, "main");
  assert.ok(events.some((event) => event.type === "text_delta"));
  assert.ok(events.some((event) => event.type === "message_end"));
});

test("RouterRuntime forwards turn abort signal into the model runtime stream", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const router = createRouterRuntime(baseConfig, { modelRuntime });
  const controller = new AbortController();

  for await (const _event of router.stream(baseRequest, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
    abortSignal: controller.signal,
  })) {
    void _event;
  }

  assert.equal(modelRuntime.signals[0], controller.signal);
});

test("RouterRuntime falls back to next provider on retryable error and suppresses failed attempt events", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      {
        type: "error",
        error: {
          provider: "primary",
          protocol: "anthropic",
          code: "overloaded_error",
          message: "boom",
          retryable: true,
        },
      },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "fb" },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const config: RouterConfig = {
    ...baseConfig,
    fallback: {
      default: [{ id: "secondary/m2", provider: "secondary", model: "m2" }],
    },
  };
  const eventLog: RouterEvent[] = [];
  const router = createRouterRuntime(config, {
    modelRuntime,
    events: { emit: (event) => eventLog.push(event) },
  });
  const collected: CanonicalModelEvent[] = [];
  for await (const event of router.stream(baseRequest, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
  })) {
    collected.push(event);
  }
  assert.equal(modelRuntime.received.length, 2);
  assert.equal(modelRuntime.received[1]?.provider, "secondary");
  assert.equal(modelRuntime.received[1]?.model, "m2");
  assert.equal(collected.filter((event) => event.type === "error").length, 0);
  assert.ok(collected.some((event) => event.type === "text_delta" && event.text === "fb"));
  assert.ok(eventLog.some((event) => event.type === "pilotdeck_router_fallback"));
});

test("RouterRuntime retries zero-usage and yields events from the successful attempt only", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "usage", usage: { totalTokens: 0 } },
      { type: "message_end", finishReason: "stop" },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "second" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const eventLog: RouterEvent[] = [];
  const router = createRouterRuntime(baseConfig, {
    modelRuntime,
    events: { emit: (event) => eventLog.push(event) },
  });
  const collected: CanonicalModelEvent[] = [];
  for await (const event of router.stream(baseRequest, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
  })) {
    collected.push(event);
  }
  assert.equal(modelRuntime.received.length, 2);
  assert.equal(collected.filter((event) => event.type === "text_delta").length, 1);
  assert.ok(eventLog.some((event) => event.type === "pilotdeck_router_zero_usage_retry"));
});

test("RouterRuntime stats observe successful attempts when stats enabled", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const router = createRouterRuntime(
    { ...baseConfig, stats: { enabled: true, filePath: `/tmp/pilotdeck-test-stats-${Date.now()}.json` } },
    { modelRuntime },
  );
  for await (const _event of router.stream(baseRequest, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
  })) {
    void _event;
  }
  const snapshot = router.stats.snapshot();
  assert.equal(snapshot.totalRequests, 1);
  assert.equal(snapshot.totalInputTokens, 5);
  assert.equal(snapshot.totalOutputTokens, 7);
  assert.equal(snapshot.perScenario.default, 1);
});

test("RouterRuntime resolves custom router contributions from PluginRuntime", async () => {
  const modelRuntime = new ScriptedModelRuntime([]);
  const plugins = new PluginRuntime({
    projectRoot: "/tmp/project",
    pilotHome: "/tmp/pilot",
    builtinPlugins: [
      {
        name: "router-plugin",
        path: "<builtin>",
        source: "builtin",
        manifest: { name: "router-plugin" },
        routerContributions: [
          {
            id: "route-fast",
            createCustomRouter: () => ({
              id: "route-fast",
              decide: async () => ({ provider: "custom", model: "fast" }),
            }),
          },
        ],
      },
    ],
  });
  await plugins.refresh();

  const router = createRouterRuntime(
    { ...baseConfig, customRouter: { extensionId: "route-fast" } },
    { modelRuntime, customRouterRegistry: plugins },
  );
  const decision = await router.decide({
    request: baseRequest,
    sessionId: "s1",
    isMainAgent: true,
  });

  assert.equal(decision.resolvedFrom, "custom");
  assert.equal(decision.provider, "custom");
  assert.equal(decision.model, "fast");
});

test("RouterRuntime loads auto-orchestrate skill prompts from PluginRuntime", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const judgeRuntime: ModelRuntime = {
    stream: modelRuntime.stream.bind(modelRuntime),
    complete: async () => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "<tier>COMPLEX</tier>" }],
      finishReason: "stop" as const,
    }),
    getCapabilities: modelRuntime.getCapabilities.bind(modelRuntime),
    getMultimodal: modelRuntime.getMultimodal.bind(modelRuntime),
  };
  const plugins = new PluginRuntime({
    projectRoot: "/tmp/project",
    pilotHome: "/tmp/pilot",
    builtinPlugins: [
      {
        name: "orchestrator",
        path: "<builtin>",
        source: "builtin",
        manifest: { name: "orchestrator" },
        skills: [
          {
            name: "orchestrate",
            path: "<builtin>/skills/orchestrate/SKILL.md",
            content: "Delegate complex work to subagents.",
            frontmatter: {},
            isSkill: true,
          },
        ],
      },
    ],
  });
  await plugins.refresh();

  const router = createRouterRuntime(
    {
      ...baseConfig,
      tokenSaver: {
        enabled: true,
        judge: { id: "primary/main", provider: "primary", model: "main" },
        judgeTimeoutMs: 10000,
        defaultTier: "COMPLEX",
        tiers: {
          SIMPLE: { model: { id: "primary/fast", provider: "primary", model: "fast" } },
          COMPLEX: { model: { id: "primary/main", provider: "primary", model: "main" } },
        },
      },
      autoOrchestrate: {
        enabled: true,
        skillExtensionId: "orchestrate",
        triggerTiers: ["COMPLEX"],
        blockedTools: [],
        slimSystemPrompt: false,
      },
    },
    {
      modelRuntime,
      judgeRuntime,
      loadSkillPrompt: (extensionId) => plugins.loadSkillPrompt(extensionId),
    },
  );
  for await (const _event of router.stream(baseRequest, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
  })) {
    void _event;
  }

  const firstMessage = modelRuntime.received[0]?.messages[0];
  assert.equal(firstMessage?.role, "user");
  assert.equal(firstMessage?.content[0]?.type, "text");
  if (firstMessage?.content[0]?.type === "text") {
    assert.match(firstMessage.content[0].text, /Delegate complex work to subagents/);
  }
});
