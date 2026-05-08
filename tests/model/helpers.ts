import type { RawModelConfig } from "../../src/model/config/schema.js";

export function validAgentConfig() {
  return {
    model: "anthropic-main/claude-sonnet-4-5",
    fallbackModel: "openai-main/gpt-5.1",
  };
}

export function validModelConfig(): RawModelConfig {
  return {
    providers: {
      "anthropic-main": {
        protocol: "anthropic",
        url: "https://api.anthropic.com",
        apiKey: "${ANTHROPIC_API_KEY}",
        timeoutMs: 120000,
        headers: {
          "anthropic-version": "2023-06-01",
        },
        models: {
          "claude-sonnet-4-5": {
            displayName: "Claude Sonnet 4.5",
            capabilities: {
              supportsToolUse: true,
              supportsStreaming: true,
              supportsParallelToolCalls: true,
              supportsThinking: true,
              supportsJsonSchema: true,
              supportsPromptCache: true,
              maxContextTokens: 200000,
              maxOutputTokens: 8192,
            },
            multimodal: {
              input: ["text", "image", "pdf"],
              maxImagesPerRequest: 20,
              maxImageBytes: 5242880,
              supportedImageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
              maxPdfPages: 100,
              imageDetail: "auto",
            },
          },
        },
      },
      "openai-main": {
        protocol: "openai",
        url: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: {
          "gpt-5.1": {
            capabilities: {
              supportsToolUse: true,
              supportsStreaming: true,
              supportsParallelToolCalls: true,
              supportsThinking: false,
              supportsJsonSchema: true,
              supportsPromptCache: false,
              maxContextTokens: 128000,
              maxOutputTokens: 8192,
            },
            multimodal: {
              input: ["text", "image", "audio"],
              maxImagesPerRequest: 20,
              maxAudioSeconds: 600,
              supportedImageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
            },
          },
        },
      },
    },
  };
}
