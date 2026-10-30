import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { buildConfigYaml, providerTypeToProtocol } from "../../apps/desktop/src/onboarding-config.js";

/**
 * 回归覆盖（PR #804 审查）：桌面 onboarding 选择 openai-responses 时，
 * 写入 sati.yaml 的 provider.protocol 必须保持 "openai-responses"。
 * 之前的默认分支把它回退成 "openai"，配置仍能通过校验，但运行时
 * reasoning 模型会请求 /v1/chat/completions 而非 /v1/responses，
 * 直到首条聊天请求失败才暴露。
 */

interface ConfigDoc {
  schemaVersion: number;
  agent: { model: string };
  model: { providers: Record<string, { protocol: string }> };
}

describe("providerTypeToProtocol", () => {
  it("保留 openai-responses（不回退到 openai）", () => {
    assert.equal(providerTypeToProtocol("openai-responses"), "openai-responses");
  });

  it("其余已知类型映射到正确的 gateway 协议", () => {
    assert.equal(providerTypeToProtocol("anthropic"), "anthropic");
    assert.equal(providerTypeToProtocol("google"), "google");
    assert.equal(providerTypeToProtocol("openai-chat"), "openai");
    assert.equal(providerTypeToProtocol("litellm"), "openai");
    assert.equal(providerTypeToProtocol("ccr"), "openai");
  });
});

describe("buildConfigYaml", () => {
  const base = { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "deepseek-v4" };

  it("openai-responses 写入 protocol: openai-responses", () => {
    const doc = parse(buildConfigYaml({ ...base, providerType: "openai-responses" })) as unknown as ConfigDoc;
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.agent.model, "sati/deepseek-v4");
    assert.equal(doc.model.providers.sati.protocol, "openai-responses");
  });

  it("anthropic / google 写入对应 protocol", () => {
    const anthropic = parse(buildConfigYaml({ ...base, providerType: "anthropic" })) as unknown as ConfigDoc;
    const google = parse(buildConfigYaml({ ...base, providerType: "google" })) as unknown as ConfigDoc;
    assert.equal(anthropic.model.providers.sati.protocol, "anthropic");
    assert.equal(google.model.providers.sati.protocol, "google");
  });

  it("未知 providerType 抛错而非静默回退", () => {
    assert.throws(() => buildConfigYaml({ ...base, providerType: "weird" }), TypeError);
  });
});
