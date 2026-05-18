import test from "node:test";
import assert from "node:assert/strict";
import { createRouterRuntime } from "../../src/router/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalModelResponse, ModelRuntime } from "../../src/model/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

function makeModelRuntime(scripts: CanonicalModelEvent[][]): ModelRuntime & { received: CanonicalModelRequest[] } {
  const received: CanonicalModelRequest[] = [];
  return {
    received,
    async *stream(request: CanonicalModelRequest) {
      received.push(request);
      const script = scripts.shift() ?? [
        { type: "message_start", role: "assistant" },
        { type: "message_end", finishReason: "stop" },
      ];
      for (const event of script) yield event;
    },
    async complete(): Promise<CanonicalModelResponse> { throw new Error("not used"); },
    getCapabilities: () => ({
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
      supportsThinking: false, supportsJsonSchema: true, supportsSystemPrompt: true,
      supportsPromptCache: false, maxContextTokens: 100_000, maxOutputTokens: 4_000,
    }),
    getMultimodal: () => ({ input: ["text" as const] }),
  };
}

const successEvents: CanonicalModelEvent[] = [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "ok" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "message_end", finishReason: "stop" },
];

const baseRequest: CanonicalModelRequest = {
  provider: "ignored", model: "ignored",
  messages: [{ role: "user", content: [{ type: "text", text: "build a complex system" }] }],
  tools: [
    { name: "bash", description: "run", inputSchema: { type: "object" } },
    { name: "agent", description: "subagent", inputSchema: { type: "object" } },
    { name: "read_file", description: "read", inputSchema: { type: "object" } },
    { name: "web_search", description: "search", inputSchema: { type: "object" } },
  ],
  systemPrompt: "You are PilotDeck.\nDo the work.\nUse memory_search if needed.\nBe precise.",
};

function makeOrchConfig(overrides?: Partial<RouterConfig["autoOrchestrate"]>): RouterConfig {
  return {
    scenarios: { default: { id: "p/main", provider: "p", model: "main" } },
    zeroUsageRetry: { enabled: false, maxAttempts: 0 },
    tokenSaver: {
      enabled: true,
      judge: { id: "p/judge", provider: "p", model: "judge" },
      defaultTier: "SIMPLE",
      tiers: {
        SIMPLE: { model: { id: "p/cheap", provider: "p", model: "cheap" } },
        COMPLEX: { model: { id: "p/main", provider: "p", model: "main" } },
      },
      judgeTimeoutMs: 5000,
    },
    autoOrchestrate: {
      enabled: true,
      triggerTiers: ["COMPLEX"],
      slimSystemPrompt: false,
      blockedTools: [],
      ...overrides,
    },
  };
}

function makeJudge(tier: string): ModelRuntime {
  return {
    stream: async function* () { throw new Error("not used"); },
    complete: async (): Promise<CanonicalModelResponse> => ({
      role: "assistant",
      content: [{ type: "text", text: `<tier>${tier}</tier>` }],
      finishReason: "stop",
    }),
    getCapabilities: () => ({
      supportsToolUse: false, supportsStreaming: false, supportsParallelToolCalls: false,
      supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: false,
      supportsPromptCache: false, maxContextTokens: 4096, maxOutputTokens: 256,
    }),
    getMultimodal: () => ({ input: ["text" as const] }),
  };
}

test("auto-orchestrate injects skill prompt into model request", async () => {
  const modelRuntime = makeModelRuntime([[...successEvents]]);
  const judgeRuntime = makeJudge("COMPLEX");
  const config = makeOrchConfig({ skillExtensionId: "orch-skill" });
  const router = createRouterRuntime(config, {
    modelRuntime,
    judgeRuntime,
    loadSkillPrompt: async () => "Delegate tasks to sub-agents for efficiency.",
  });
  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: true })) { void _; }

  const firstMsg = modelRuntime.received[0]?.messages[0];
  assert.equal(firstMsg?.role, "user");
  if (firstMsg?.content[0]?.type === "text") {
    assert.match(firstMsg.content[0].text, /Delegate tasks to sub-agents/);
  }
});

test("auto-orchestrate filters tools with allowedTools", async () => {
  const modelRuntime = makeModelRuntime([[...successEvents]]);
  const judgeRuntime = makeJudge("COMPLEX");
  const config = makeOrchConfig({ allowedTools: ["agent", "read_file"], blockedTools: undefined });
  const router = createRouterRuntime(config, { modelRuntime, judgeRuntime });
  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: true })) { void _; }

  const tools = modelRuntime.received[0]?.tools ?? [];
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("agent"));
  assert.ok(names.includes("read_file"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("web_search"));
});

test("auto-orchestrate does not trigger for subagent requests", async () => {
  const modelRuntime = makeModelRuntime([[...successEvents]]);
  const judgeRuntime = makeJudge("COMPLEX");
  const config = makeOrchConfig({ allowedTools: ["agent"] });
  const router = createRouterRuntime(config, { modelRuntime, judgeRuntime });
  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: false })) { void _; }

  const tools = modelRuntime.received[0]?.tools ?? [];
  assert.equal(tools.length, 4);
});

test("auto-orchestrate slims system prompt preserving memory keywords", async () => {
  const modelRuntime = makeModelRuntime([[...successEvents]]);
  const judgeRuntime = makeJudge("COMPLEX");
  const config = makeOrchConfig({ slimSystemPrompt: true });
  const router = createRouterRuntime(config, { modelRuntime, judgeRuntime });
  for await (const _ of router.stream(baseRequest, { sessionId: "s1", turnId: "t1", isMainAgent: true })) { void _; }

  const systemPrompt = modelRuntime.received[0]?.systemPrompt ?? "";
  assert.ok(systemPrompt.includes("orchestration agent"));
  assert.ok(systemPrompt.includes("memory_search"));
  assert.ok(!systemPrompt.includes("Do the work"));
});
