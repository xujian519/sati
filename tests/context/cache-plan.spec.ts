import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptCachePlan,
  promptCacheEnabled,
  RECENT_MESSAGE_BREAKPOINT_COUNT,
  resolveRequestCachePlan,
  selectRecentMessageBreakpoints,
  stableSerialize,
} from "../../src/context/cache/CachePlan.js";
import { buildLiteLLMContinuationRequest } from "../../src/model/streaming/continuationRequest.js";
import { buildAnthropicRequest } from "../../src/model/providers/anthropic/request.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../src/model/index.js";

function anthropicModel(): ModelDefinition {
  return {
    id: "m",
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsPromptCache: true, maxOutputTokens: 8_192 },
    multimodal: DEFAULT_MULTIMODAL_CONSTRAINTS,
  };
}

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function tool(name: string): CanonicalToolSchema {
  return { name, description: `tool ${name}`, inputSchema: { type: "object" } };
}

test("selectRecentMessageBreakpoints picks the last three message indices", () => {
  const messages = [
    textMessage("user", "1"),
    textMessage("assistant", "2"),
    textMessage("user", "3"),
    textMessage("assistant", "4"),
    textMessage("user", "5"),
  ];
  assert.deepEqual(selectRecentMessageBreakpoints(messages), [2, 3, 4]);
  assert.deepEqual(selectRecentMessageBreakpoints([textMessage("user", "only")]), [0]);
  assert.deepEqual(selectRecentMessageBreakpoints([]), []);
});

test("stableSerialize sorts keys so equal content yields equal output", () => {
  assert.equal(stableSerialize({ b: 1, a: 2 }), stableSerialize({ a: 2, b: 1 }));
  assert.notEqual(stableSerialize({ a: 1 }), stableSerialize({ a: 2 }));
});

test("promptCacheEnabled honors SATI_PROMPT_CACHE=off", () => {
  assert.equal(promptCacheEnabled({}), true);
  assert.equal(promptCacheEnabled({ SATI_PROMPT_CACHE: "on" }), true);
  assert.equal(promptCacheEnabled({ SATI_PROMPT_CACHE: "off" }), false);
});

test("buildPromptCachePlan marks system and stamps a stable fingerprint", () => {
  const messages = [textMessage("user", "1"), textMessage("assistant", "2"), textMessage("user", "3")];
  const input = {
    provider: "anthropic",
    model: "claude-sonnet-4.6",
    systemPrompt: "sys",
    tools: [tool("b"), tool("a")],
    messages,
  };
  const plan = buildPromptCachePlan(input, 7);
  assert.equal(plan.system, true);
  assert.deepEqual(plan.messages, [0, 1, 2]);
  assert.equal(plan.generation, 7);
  assert.equal(plan.fingerprint, buildPromptCachePlan(input, 8).fingerprint);
  // 工具顺序不稳定化会导致指纹漂移：换序后指纹必须不变。
  assert.equal(plan.fingerprint, buildPromptCachePlan({ ...input, tools: [tool("a"), tool("b")] }, 7).fingerprint);
  // 消息内容变化必须改变指纹。
  const changed = buildPromptCachePlan({ ...input, messages: [...messages, textMessage("user", "4")] }, 7);
  assert.notEqual(plan.fingerprint, changed.fingerprint);
});

test("resolveRequestCachePlan returns undefined when disabled, explicit, or empty", () => {
  const base = {
    provider: "anthropic",
    model: "m",
    systemPrompt: "sys",
    tools: [],
    messages: [textMessage("user", "hi")],
  };
  assert.equal(resolveRequestCachePlan({ ...base, enabled: false }, 1), undefined);
  assert.equal(resolveRequestCachePlan({ ...base, enabled: true, explicitBreakpoints: [0] }, 1), undefined);
  assert.equal(resolveRequestCachePlan({ ...base, enabled: true, messages: [] }, 1), undefined);
  const plan = resolveRequestCachePlan({ ...base, enabled: true }, 1);
  assert.ok(plan);
  assert.deepEqual(plan.messages, [0]);
});

test("anthropic request consumes the cache plan (system tail + recent messages)", () => {
  const messages = [
    textMessage("user", "1"),
    textMessage("assistant", "2"),
    textMessage("user", "3"),
    textMessage("assistant", "4"),
    textMessage("user", "5"),
  ];
  const plan = buildPromptCachePlan({ provider: "anthropic", model: "m", systemPrompt: "sys", tools: [], messages }, 1);
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "m",
    messages,
    systemPrompt: "sys",
    cachePlan: plan,
  };
  const body = buildAnthropicRequest(request, anthropicModel());

  const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
  // system 尾块带 cache_control。
  assert.ok(system.length === 1);
  assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
  // 只有 plan 里的消息索引被打点。
  const marked = body.messages
    .map((message, index) => ({ index, marked: JSON.stringify(message.content).includes("cache_control") }))
    .filter(entry => entry.marked)
    .map(entry => entry.index);
  assert.deepEqual(marked, plan.messages);
});

test("anthropic request keeps legacy cacheBreakpoints behavior without a plan", () => {
  const messages = [textMessage("user", "1"), textMessage("assistant", "2"), textMessage("user", "3")];
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "m",
    messages,
    systemPrompt: "sys",
    cacheBreakpoints: [0],
  };
  const body = buildAnthropicRequest(request, anthropicModel());
  const marked = body.messages
    .map((message, index) => ({ index, marked: JSON.stringify(message.content).includes("cache_control") }))
    .filter(entry => entry.marked)
    .map(entry => entry.index);
  assert.deepEqual(marked, [0]);
  assert.ok(JSON.stringify(body.system).includes("cache_control"));
});

test("stream continuation clears cachePlan and cacheBreakpoints", () => {
  const original: CanonicalModelRequest = {
    provider: "anthropic",
    model: "m",
    messages: [textMessage("user", "1")],
    systemPrompt: "sys",
    cacheBreakpoints: [0],
    cachePlan: buildPromptCachePlan(
      { provider: "anthropic", model: "m", systemPrompt: "sys", tools: [], messages: [textMessage("user", "1")] },
      3,
    ),
  };
  const continued = buildLiteLLMContinuationRequest(original, "partial text");
  assert.equal(continued.cachePlan, undefined);
  assert.equal(continued.cacheBreakpoints, undefined);
});

test("recent breakpoint count stays within the anthropic 4-block budget (system + 3)", () => {
  assert.equal(RECENT_MESSAGE_BREAKPOINT_COUNT, 3);
});
