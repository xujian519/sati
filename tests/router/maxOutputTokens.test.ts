import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelCapabilities,
  ModelRuntime,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";

const textOnly: MultimodalConstraints = { input: ["text"] };
const imageCapable: MultimodalConstraints = { input: ["text", "image"] };
const baseCapabilities: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: false,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
};

describe("RouterRuntime max output token caps", () => {
  it("clips explicit maxOutputTokens to the attempted fallback model cap", async () => {
    let seenRequest: CanonicalModelRequest | undefined;
    const modelRuntime: ModelRuntime = {
      async *stream(request) {
        seenRequest = request;
        yield { type: "message_end", finishReason: "stop" };
      },
      async complete(): Promise<CanonicalModelResponse> {
        return { role: "assistant", content: [], finishReason: "stop" };
      },
      getCapabilities(providerId, modelId) {
        if (providerId === "fallback" && modelId === "small") {
          return { ...baseCapabilities, maxOutputTokens: 8_192 };
        }
        return { ...baseCapabilities, maxOutputTokens: 384 * 1024 };
      },
      getMultimodal() {
        return textOnly;
      },
      getProviderProtocol() {
        return "openai";
      },
      getProviderBaseUrl() {
        return "https://example.test/v1";
      },
    };

    const router = createRouterRuntime({
      enabled: true,
      zeroUsageRetry: { enabled: false, maxAttempts: 0 },
      scenarios: {
        default: { id: "primary/big", provider: "primary", model: "big" },
      },
    }, { modelRuntime });

    const decision: RouterDecision = {
      provider: "fallback",
      model: "small",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    };
    const request: CanonicalModelRequest = {
      provider: "primary",
      model: "big",
      maxOutputTokens: 384 * 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };

    for await (const _event of router.execute(decision, request, { sessionId: "s", turnId: "t" })) {
      // Drain the stream.
    }

    assert.equal(seenRequest?.provider, "fallback");
    assert.equal(seenRequest?.model, "small");
    assert.equal(seenRequest?.maxOutputTokens, 8_192);
    await router.shutdown();
  });

  it("downgrades images to text when no configured fallback supports image input", async () => {
    let seenRequest: CanonicalModelRequest | undefined;
    const modelRuntime = createStreamRuntime({
      "deepseek/deepseek-v4-pro": textOnly,
      "fallback/text": textOnly,
    }, (request) => {
      seenRequest = request;
    });
    const router = createRouterRuntime({
      enabled: true,
      zeroUsageRetry: { enabled: false, maxAttempts: 0 },
      scenarios: {
        default: { id: "deepseek/deepseek-v4-pro", provider: "deepseek", model: "deepseek-v4-pro" },
      },
      fallback: {
        default: [{ id: "fallback/text", provider: "fallback", model: "text" }],
      },
    }, { modelRuntime });
    const decision: RouterDecision = {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "scenario",
      mutations: {},
    };
    const request = imageRequest();
    let sawError = false;

    for await (const event of router.execute(decision, request, { sessionId: "s", turnId: "t" })) {
      sawError = sawError || event.type === "error";
    }

    const block = seenRequest?.messages[0]?.content[1];
    assert.equal(seenRequest?.provider, "deepseek");
    assert.equal(seenRequest?.model, "deepseek-v4-pro");
    assert.equal(block?.type, "text");
    assert.match(block?.type === "text" ? block.text : "", /omitted, model does not support image input/);
    assert.equal(request.messages[0]?.content[1]?.type, "image");
    assert.equal(sawError, false);
    await router.shutdown();
  });

  it("keeps images when a configured fallback supports image input", async () => {
    let seenRequest: CanonicalModelRequest | undefined;
    const modelRuntime = createStreamRuntime({
      "deepseek/deepseek-v4-pro": textOnly,
      "vision/model": imageCapable,
    }, (request) => {
      seenRequest = request;
    });
    const router = createRouterRuntime({
      enabled: true,
      zeroUsageRetry: { enabled: false, maxAttempts: 0 },
      scenarios: {
        default: { id: "deepseek/deepseek-v4-pro", provider: "deepseek", model: "deepseek-v4-pro" },
      },
      fallback: {
        default: [{ id: "vision/model", provider: "vision", model: "model" }],
      },
    }, { modelRuntime });
    const decision: RouterDecision = {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "scenario",
      mutations: {},
    };

    for await (const _event of router.execute(decision, imageRequest(), { sessionId: "s", turnId: "t" })) {
      // Drain the stream.
    }

    assert.equal(seenRequest?.provider, "vision");
    assert.equal(seenRequest?.model, "model");
    assert.equal(seenRequest?.messages[0]?.content[1]?.type, "image");
    await router.shutdown();
  });
});

function createStreamRuntime(
  multimodalByModel: Record<string, MultimodalConstraints>,
  onStream: (request: CanonicalModelRequest) => void,
): ModelRuntime {
  return {
    async *stream(request) {
      onStream(request);
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return { role: "assistant", content: [], finishReason: "stop" };
    },
    getCapabilities() {
      return baseCapabilities;
    },
    getMultimodal(providerId, modelId) {
      const multimodal = multimodalByModel[`${providerId}/${modelId}`];
      if (!multimodal) {
        throw new Error(`Unknown model ${providerId}/${modelId}`);
      }
      return multimodal;
    },
    getProviderProtocol() {
      return "openai";
    },
    getProviderBaseUrl() {
      return "https://example.test/v1";
    },
  };
}

function imageRequest(): CanonicalModelRequest {
  return {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", source: "base64", data: "aW1hZ2U=", mimeType: "image/png", bytes: 2048 },
      ],
    }],
  };
}
