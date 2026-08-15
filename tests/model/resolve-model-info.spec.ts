/**
 * 精确能力解析与模态门禁测试（阶段四 T3）。
 *
 * 覆盖：resolveModelInfo 三层解析（config/catalog/default）与来源标注、
 * assertInputModality 通过/拒绝、validateModelRequest 序列化前纵深防御
 * （已声明文本模型 + 图片消息 → unsupported_modality）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createModelRuntime } from "../../src/model/ModelRuntime.js";
import { resolveModelInfo } from "../../src/model/resolveModelInfo.js";
import { assertInputModality, DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { validateModelRequest } from "../../src/model/request/validateModelRequest.js";
import { ModelRequestError } from "../../src/model/protocol/errors.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { ModelConfig } from "../../src/model/protocol/canonical.js";

const VISION_MODEL_CONFIG: ModelConfig = {
  providers: {
    openai: {
      id: "openai",
      protocol: "openai",
      url: "https://api.openai.com/v1",
      apiKey: "sk-test",
      headers: {},
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true },
          multimodal: { input: ["text", "image"], maxImagesPerRequest: 10 },
        },
      },
    },
  },
};

function makeRuntime(config: ModelConfig) {
  return createModelRuntime(config);
}

test("resolveModelInfo：config 声明命中（source=config）", () => {
  const runtime = makeRuntime(VISION_MODEL_CONFIG);
  const resolved = resolveModelInfo(runtime, "openai", "gpt-4o");
  assert.equal(resolved.source, "config");
  assert.deepEqual(resolved.multimodal.input, ["text", "image"]);
  assert.equal(resolved.capabilities.supportsToolUse, true);
});

test("resolveModelInfo：未知模型回退 catalog（source=catalog）", () => {
  // 空 config：getMultimodal/getCapabilities 抛 provider_not_found → catalog 回退。
  const runtime = makeRuntime({ providers: {} });
  const resolved = resolveModelInfo(runtime, "openai", "gpt-4o");
  assert.equal(resolved.source, "catalog");
  assert.equal(resolved.multimodal.input.includes("image"), true);
});

test("resolveModelInfo：未知 provider 回退默认（source=default, text-only）", () => {
  const runtime = makeRuntime({ providers: {} });
  const resolved = resolveModelInfo(runtime, "unknown-provider", "m");
  assert.equal(resolved.source, "default");
  assert.deepEqual(resolved.multimodal.input, DEFAULT_MULTIMODAL_CONSTRAINTS.input);
  assert.equal(resolved.capabilities.maxContextTokens, DEFAULT_MODEL_CAPABILITIES.maxContextTokens);
});

test("assertInputModality：支持则通过，不支持则抛稳定错误", () => {
  assertInputModality({ input: ["text", "image"] }, "image");
  assert.throws(
    () => assertInputModality({ input: ["text"] }, "image", "deepseek-chat"),
    (error: unknown) => error instanceof ModelRequestError && error.code === "unsupported_input_modality",
  );
  assert.throws(
    () => assertInputModality({ input: ["text"] }, "image"),
    (error: unknown) => error instanceof ModelRequestError && String(error.message).includes("the current model"),
  );
});

test("序列化前纵深防御：已声明文本模型 + 图片消息 → unsupported_modality（T3.3 锁定既有行为）", () => {
  const textOnlyConfig: ModelConfig = {
    providers: {
      deepseek: {
        id: "deepseek",
        protocol: "openai",
        url: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        headers: {},
        models: {
          "deepseek-chat": {
            id: "deepseek-chat",
            capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsStreaming: true },
            multimodal: { input: ["text"] },
          },
        },
      },
    },
  };
  const request = {
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "image" as const, source: "base64" as const, data: "aGVsbG8=", mimeType: "image/png" }],
      },
    ],
  };
  assert.throws(
    () => validateModelRequest(request, textOnlyConfig),
    (error: unknown) => error instanceof ModelRequestError && error.code === "unsupported_modality",
  );
});
