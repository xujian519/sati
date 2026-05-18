import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../../src/agent/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";
import { ToolRegistry, ToolRuntime, SequentialToolScheduler } from "../../src/tool/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { createPilotDeckTestTool } from "../helpers/tool.js";
import { collectAsyncGenerator } from "../helpers/agent.js";

class ScriptedModelRuntime implements ModelRuntime {
  readonly received: CanonicalModelRequest[] = [];
  constructor(private readonly scripts: CanonicalModelEvent[][]) {}

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.received.push(request);
    const script = this.scripts.shift() ?? [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ];
    for (const event of script) yield event;
  }
  async complete(): Promise<import("../../src/model/index.js").CanonicalModelResponse> { throw new Error("not used"); }
  getCapabilities() {
    return {
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
      supportsThinking: false, supportsJsonSchema: true, supportsSystemPrompt: true,
      supportsPromptCache: false, maxContextTokens: 100_000, maxOutputTokens: 4_000,
    };
  }
  getMultimodal() { return { input: ["text" as const] }; }
}

function buildAgentWithRouter(
  modelRuntime: ScriptedModelRuntime,
  routerConfig: RouterConfig,
  tools?: ReturnType<typeof createPilotDeckTestTool>[],
  events?: { emit: (event: RouterEvent) => void },
) {
  const router = createRouterRuntime(routerConfig, { modelRuntime, events });
  const registry = new ToolRegistry();
  for (const t of tools ?? []) registry.register(t);
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const cwd = process.cwd();
  const loop = new AgentLoop(
    {
      provider: "ignored", model: "ignored", cwd,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
    },
    { router, tools: { registry, scheduler } },
  );
  return { router, loop };
}

const baseConfig: RouterConfig = {
  scenarios: { default: { id: "primary/main", provider: "primary", model: "main" } },
  zeroUsageRetry: { enabled: false, maxAttempts: 0 },
};

test("AgentLoop + RouterRuntime routes to default scenario provider/model", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "hello" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const { loop } = buildAgentWithRouter(modelRuntime, baseConfig);
  const { result } = await collectAsyncGenerator(
    loop.run({ sessionId: "s1", turnId: "t1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  );
  assert.equal(result.result.type, "success");
  assert.equal(modelRuntime.received[0]?.provider, "primary");
  assert.equal(modelRuntime.received[0]?.model, "main");
});

test("AgentLoop + RouterRuntime falls back on retryable error", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "error", error: { provider: "primary", protocol: "openai", code: "overloaded", message: "busy", retryable: true } },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const config: RouterConfig = {
    ...baseConfig,
    fallback: { default: [{ id: "backup/fallback", provider: "backup", model: "fallback" }] },
  };
  const eventLog: RouterEvent[] = [];
  const { loop } = buildAgentWithRouter(modelRuntime, config, [], { emit: (e) => eventLog.push(e) });
  const { result } = await collectAsyncGenerator(
    loop.run({ sessionId: "s1", turnId: "t1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  );
  assert.equal(result.result.type, "success");
  assert.equal(modelRuntime.received.length, 2);
  assert.equal(modelRuntime.received[1]?.provider, "backup");
  assert.ok(eventLog.some((e) => e.type === "pilotdeck_router_fallback"));
});

test("AgentLoop + RouterRuntime handles tool execution then routes second turn correctly", async () => {
  const lookupTool = createPilotDeckTestTool({
    name: "lookup",
    inputSchema: { type: "object", required: ["q"], additionalProperties: false, properties: { q: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text", text: "result-42" }] }),
  });
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "c1", name: "lookup", input: { q: "x" } } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "The result is 42." },
      { type: "usage", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const { loop } = buildAgentWithRouter(modelRuntime, baseConfig, [lookupTool]);
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 5,
      messages: [{ role: "user", content: [{ type: "text", text: "lookup x" }] }],
    }),
  );
  assert.equal(result.result.type, "success");
  assert.equal(modelRuntime.received.length, 2);
  assert.equal(modelRuntime.received[1]?.provider, "primary");
  assert.equal(modelRuntime.received[1]?.model, "main");
});

test("AgentLoop + RouterRuntime stats reflect completed turn", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const config: RouterConfig = {
    ...baseConfig,
    stats: { enabled: true, filePath: `/tmp/pilotdeck-integ-stats-${Date.now()}.json` },
  };
  const { router, loop } = buildAgentWithRouter(modelRuntime, config);
  await collectAsyncGenerator(
    loop.run({ sessionId: "s1", turnId: "t1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  );
  const snap = router.stats.snapshot();
  assert.equal(snap.totalRequests, 1);
  assert.equal(snap.totalInputTokens, 5);
  assert.equal(snap.totalOutputTokens, 7);
});

test("AgentLoop + RouterRuntime multi-turn routing is consistent", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "c1", name: "noop", input: {} } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "c2", name: "noop", input: {} } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "done" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const noopTool = createPilotDeckTestTool({ name: "noop" });
  const { loop } = buildAgentWithRouter(modelRuntime, baseConfig, [noopTool]);
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1", turnId: "t1", maxTurns: 5,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }),
  );
  assert.equal(result.result.type, "success");
  assert.equal(modelRuntime.received.length, 3);
  for (const req of modelRuntime.received) {
    assert.equal(req.provider, "primary");
    assert.equal(req.model, "main");
  }
});

test("AgentLoop + RouterRuntime respects explicit scenario override", async () => {
  const modelRuntime = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const router = createRouterRuntime(baseConfig, { modelRuntime });
  const registry = new ToolRegistry();
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const cwd = process.cwd();
  const loop = new AgentLoop(
    {
      provider: "ignored", model: "ignored", cwd,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
      metadata: { explicitProvider: "primary", explicitModel: "main" },
    },
    { router, tools: { registry, scheduler } },
  );
  const { result } = await collectAsyncGenerator(
    loop.run({ sessionId: "s1", turnId: "t1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
  );
  assert.equal(result.result.type, "success");
  assert.equal(modelRuntime.received[0]?.provider, "primary");
});
