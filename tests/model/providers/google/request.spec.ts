import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest, ModelCapabilities, ModelDefinition } from "../../../../src/model/index.js";
import { buildGoogleRequest } from "../../../../src/model/providers/google/request.js";

const capabilities: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: true,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 1_048_576,
  maxOutputTokens: 393_216,
};

function model(id: string): ModelDefinition {
  return { id, capabilities, multimodal: { input: ["text"] } };
}

function googleRequest(modelId: string, mode: "low" | "medium" | "high"): CanonicalModelRequest {
  return {
    model: modelId,
    provider: "google",
    messages: [],
    thinking: { mode, enabled: true },
  };
}

// Gemini 3.x 走 thinkingLevel/useGeminiLevel 路径（registry.ts googlePlan），
// 本地小写 level 必须映射为 SDK ThinkingLevel 枚举的大写值（行为修正回归守卫）。
test("gemini-3.x maps local thinking level to uppercase ThinkingLevel enum", () => {
  const high = buildGoogleRequest(googleRequest("gemini-3.1-pro-preview", "high"), model("gemini-3.1-pro-preview"));
  assert.equal(high.config!.thinkingConfig?.thinkingLevel, "HIGH");
  const medium = buildGoogleRequest(googleRequest("gemini-3.6-flash", "medium"), model("gemini-3.6-flash"));
  assert.equal(medium.config!.thinkingConfig?.thinkingLevel, "MEDIUM");
  const low = buildGoogleRequest(googleRequest("gemini-3.6-flash", "low"), model("gemini-3.6-flash"));
  assert.equal(low.config!.thinkingConfig?.thinkingLevel, "LOW");
});

// gemini-2.5 走 thinkingBudget/useGeminiBudget 路径，输出 thinkingBudget 而非 thinkingLevel。
test("gemini-2.5 does not emit thinkingLevel (uses thinkingBudget)", () => {
  const body = buildGoogleRequest(googleRequest("gemini-2.5-pro", "high"), model("gemini-2.5-pro"));
  const config = body.config!;
  assert.equal(config.thinkingConfig?.thinkingLevel, undefined);
  // thinkingBudget 由 GEMINI_25_BUDGETS 决定（high 映射到 24576）。
  assert.equal(config.thinkingConfig?.thinkingBudget, 24576);
});
