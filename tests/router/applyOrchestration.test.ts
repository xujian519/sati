import test from "node:test";
import assert from "node:assert/strict";
import { applyOrchestration } from "../../src/router/orchestrate/applyOrchestration.js";
import type { RouterAutoOrchestrateConfig } from "../../src/router/config/schema.js";
import type { CanonicalModelRequest, CanonicalToolSchema } from "../../src/model/index.js";

function makeConfig(overrides?: Partial<RouterAutoOrchestrateConfig>): RouterAutoOrchestrateConfig {
  return {
    enabled: true,
    triggerTiers: ["COMPLEX"],
    slimSystemPrompt: false,
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<CanonicalModelRequest>): CanonicalModelRequest {
  return {
    provider: "p",
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [
      { name: "bash", description: "run commands", inputSchema: { type: "object" } } as CanonicalToolSchema,
      { name: "read_file", description: "read files", inputSchema: { type: "object" } } as CanonicalToolSchema,
      { name: "web_search", description: "search the web", inputSchema: { type: "object" } } as CanonicalToolSchema,
      { name: "agent", description: "spawn subagent", inputSchema: { type: "object" } } as CanonicalToolSchema,
    ],
    ...overrides,
  };
}

test("applyOrchestration injects skill prompt as system-reminder on first turn", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig(),
    isMainAgent: true,
    tier: "COMPLEX",
    alreadyOrchestrating: false,
    skillPrompt: "Delegate complex work to subagents.",
  });
  assert.equal(result.applied, true);
  assert.equal(result.request.messages[0].role, "user");
  const text = result.request.messages[0].content[0];
  assert.equal(text.type, "text");
  if (text.type === "text") {
    assert.match(text.text, /<system-reminder>/);
    assert.match(text.text, /Delegate complex work to subagents/);
  }
  assert.ok(result.mutations.orchestrationPromptInjected);
});

test("applyOrchestration continues when alreadyOrchestrating skips triggerTier check", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig({ triggerTiers: ["COMPLEX"] }),
    isMainAgent: true,
    tier: "SIMPLE",
    alreadyOrchestrating: true,
    skillPrompt: "Continue orchestrating.",
  });
  assert.equal(result.applied, true);
});

test("applyOrchestration does not trigger when tier not in triggerTiers", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig({ triggerTiers: ["COMPLEX"] }),
    isMainAgent: true,
    tier: "SIMPLE",
    alreadyOrchestrating: false,
    skillPrompt: "Should not appear.",
  });
  assert.equal(result.applied, false);
});

test("applyOrchestration filters tools with allowedTools", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig({ allowedTools: ["bash", "agent"], triggerTiers: [] }),
    isMainAgent: true,
    tier: "COMPLEX",
    alreadyOrchestrating: true,
  });
  assert.equal(result.applied, true);
  const toolNames = result.request.tools!.map((t: CanonicalToolSchema) => t.name);
  assert.deepEqual(toolNames, ["bash", "agent"]);
  assert.ok(result.mutations.toolsStripped);
  assert.equal(result.mutations.toolsStripped!.mode, "allowlist");
});

test("applyOrchestration filters tools with blockedTools", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig({ blockedTools: ["web_search"], triggerTiers: [] }),
    isMainAgent: true,
    tier: "COMPLEX",
    alreadyOrchestrating: true,
  });
  assert.equal(result.applied, true);
  const toolNames = result.request.tools!.map((t: CanonicalToolSchema) => t.name);
  assert.ok(!toolNames.includes("web_search"));
  assert.ok(toolNames.includes("bash"));
  assert.equal(result.mutations.toolsStripped!.mode, "blocklist");
});

test("applyOrchestration trims system prompt when slimSystemPrompt is true", () => {
  const longSystemPrompt = "You are PilotDeck.\nDo things well.\nmemory_search is available.\nUse tools wisely.";
  const result = applyOrchestration({
    request: makeRequest({ systemPrompt: longSystemPrompt }),
    config: makeConfig({ slimSystemPrompt: true, triggerTiers: [] }),
    isMainAgent: true,
    alreadyOrchestrating: true,
  });
  assert.equal(result.applied, true);
  assert.ok(result.request.systemPrompt!.includes("orchestration agent"));
  assert.ok(result.request.systemPrompt!.includes("memory_search"));
  assert.ok(!result.request.systemPrompt!.includes("Do things well"));
  assert.ok(result.mutations.systemPromptSlim);
});

test("applyOrchestration does not apply for non-main agent", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig({ triggerTiers: [] }),
    isMainAgent: false,
    tier: "COMPLEX",
    alreadyOrchestrating: true,
    skillPrompt: "Should not be injected.",
  });
  assert.equal(result.applied, false);
});

test("applyOrchestration trims tools even without skill prompt", () => {
  const result = applyOrchestration({
    request: makeRequest(),
    config: makeConfig({ allowedTools: ["bash"], triggerTiers: [] }),
    isMainAgent: true,
    alreadyOrchestrating: true,
  });
  assert.equal(result.applied, true);
  assert.equal(result.request.tools!.length, 1);
  assert.ok(!result.mutations.orchestrationPromptInjected);
  assert.ok(result.mutations.toolsStripped);
});
