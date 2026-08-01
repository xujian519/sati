import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveEmbeddingClient } from "../../../src/model/embedding/resolve.js";
import type { ModelConfig } from "../../../src/model/protocol/canonical.js";
import type { PilotConfigDiagnostic, PilotMemoryEmbeddingConfig } from "../../../src/pilot/config/types.js";

const modelConfig: ModelConfig = {
  providers: {
    ollama: {
      id: "ollama",
      protocol: "openai",
      url: "http://localhost:11434/v1",
      apiKey: "ollama",
      models: {},
      headers: {},
    },
    openai: {
      id: "openai",
      protocol: "openai",
      url: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: {},
      headers: {},
    },
  },
};

function makeCfg(overrides: Partial<PilotMemoryEmbeddingConfig>): PilotMemoryEmbeddingConfig {
  return { enabled: true, model: "bge-m3", ...overrides };
}

describe("resolveEmbeddingClient", () => {
  it("未配置或 disabled 返回 undefined", () => {
    assert.equal(resolveEmbeddingClient(undefined, modelConfig), undefined);
    assert.equal(resolveEmbeddingClient(makeCfg({ enabled: false }), modelConfig), undefined);
  });

  it("provider 形态复用 model.providers 的 url/apiKey", () => {
    const client = resolveEmbeddingClient(makeCfg({ provider: "ollama" }), modelConfig);
    assert.ok(client);
    assert.equal(client.dimensions, 0); // 未确认维度
  });

  it("provider 未知时返回 undefined 并给 warning 诊断", () => {
    const diagnostics: PilotConfigDiagnostic[] = [];
    const client = resolveEmbeddingClient(makeCfg({ provider: "ghost" }), modelConfig, diagnostics);
    assert.equal(client, undefined);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.code, "CONFIG_MEMORY_EMBEDDING_PROVIDER_NOT_FOUND");
  });

  it("baseUrl 形态直配", () => {
    const client = resolveEmbeddingClient(
      makeCfg({ baseUrl: "http://localhost:11434/v1", apiKey: "ollama", dimensions: 1024 }),
      modelConfig,
    );
    assert.ok(client);
    assert.equal(client.dimensions, 1024);
  });

  it("provider 与 baseUrl 均缺时返回 undefined + 诊断", () => {
    const diagnostics: PilotConfigDiagnostic[] = [];
    const client = resolveEmbeddingClient(
      makeCfg({ provider: undefined, baseUrl: undefined }),
      modelConfig,
      diagnostics,
    );
    assert.equal(client, undefined);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.code, "CONFIG_MEMORY_EMBEDDING_INVALID");
  });

  it("model 为空返回 undefined", () => {
    const client = resolveEmbeddingClient(makeCfg({ model: "  " }), modelConfig);
    assert.equal(client, undefined);
  });
});
