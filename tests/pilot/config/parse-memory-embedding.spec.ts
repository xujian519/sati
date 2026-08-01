import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PilotConfigError, type PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";
import { parseMemoryConfig } from "../../../src/pilot/config/parseMemoryConfig.js";
import type { ModelConfig } from "../../../src/model/protocol/canonical.js";

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
  },
};

function parse(
  rawMemory: unknown,
  model?: ModelConfig,
): {
  config?: ReturnType<typeof parseMemoryConfig>;
  diagnostics: PilotConfigDiagnostic[];
} {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseMemoryConfig(rawMemory, diagnostics, "/tmp/default-root", model);
  return { config, diagnostics };
}

describe("parseMemoryConfig embedding 段", () => {
  it("provider 形态解析成功（默认值填充）", () => {
    const { config, diagnostics } = parse({
      enabled: true,
      provider: "edgeclaw",
      embedding: { provider: "ollama", model: "bge-m3" },
    });
    assert.equal(diagnostics.length, 0);
    assert.equal(config?.embedding?.enabled, true);
    assert.equal(config?.embedding?.provider, "ollama");
    assert.equal(config?.embedding?.model, "bge-m3");
    assert.equal(config?.embedding?.indexMemory, true);
    assert.equal(config?.embedding?.indexWiki, true);
  });

  it("baseUrl 形态解析成功", () => {
    const { config, diagnostics } = parse({
      enabled: true,
      provider: "edgeclaw",
      embedding: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", model: "bge-m3", dimensions: 1024 },
    });
    assert.equal(diagnostics.length, 0);
    assert.equal(config?.embedding?.baseUrl, "http://localhost:11434/v1");
    assert.equal(config?.embedding?.apiKey, "ollama");
    assert.equal(config?.embedding?.dimensions, 1024);
  });

  it("未知字段产生 warning 诊断", () => {
    const { diagnostics } = parse({
      enabled: true,
      provider: "edgeclaw",
      embedding: { provider: "ollama", model: "bge-m3", nonsense: 1 },
    });
    assert.ok(
      diagnostics.some(d => d.code === "CONFIG_MEMORY_UNKNOWN_FIELD" && d.path === "memory.embedding.nonsense"),
    );
  });

  it("provider 与 baseUrl 均缺时报错", () => {
    assert.throws(
      () => parse({ enabled: true, provider: "edgeclaw", embedding: { model: "bge-m3" } }),
      (error: unknown) => error instanceof PilotConfigError && error.code === "CONFIG_MEMORY_EMBEDDING_INVALID",
    );
  });

  it("缺 model 报错", () => {
    assert.throws(
      () => parse({ enabled: true, provider: "edgeclaw", embedding: { provider: "ollama" } }),
      (error: unknown) => error instanceof PilotConfigError && error.code === "CONFIG_MEMORY_EMBEDDING_INVALID",
    );
  });

  it("未知 provider 引用产生 warning（不 fatal）", () => {
    const { config, diagnostics } = parse(
      {
        enabled: true,
        provider: "edgeclaw",
        embedding: { provider: "ghost", model: "bge-m3" },
      },
      modelConfig,
    );
    assert.ok(config);
    assert.ok(diagnostics.some(d => d.code === "CONFIG_MEMORY_EMBEDDING_PROVIDER_NOT_FOUND"));
  });

  it("enabled: false 保留配置但关闭", () => {
    const { config } = parse({
      enabled: true,
      provider: "edgeclaw",
      embedding: { provider: "ollama", model: "bge-m3", enabled: false },
    });
    assert.equal(config?.embedding?.enabled, false);
  });

  it("embedding 缺失时返回 undefined（不报错）", () => {
    const { config, diagnostics } = parse({ enabled: true, provider: "edgeclaw" });
    assert.equal(config?.embedding, undefined);
    assert.equal(diagnostics.length, 0);
  });

  it("rerank 子段解析（provider 形态）", () => {
    const { config, diagnostics } = parse({
      enabled: true,
      provider: "edgeclaw",
      embedding: {
        provider: "ollama",
        model: "bge-m3",
        rerank: { provider: "tei", model: "bge-reranker-v2-m3", topN: 8 },
      },
    });
    assert.equal(diagnostics.length, 0);
    assert.equal(config?.embedding?.rerank?.enabled, true);
    assert.equal(config?.embedding?.rerank?.provider, "tei");
    assert.equal(config?.embedding?.rerank?.model, "bge-reranker-v2-m3");
    assert.equal(config?.embedding?.rerank?.topN, 8);
  });

  it("rerank 子段解析（baseUrl 形态）", () => {
    const { config } = parse({
      enabled: true,
      provider: "edgeclaw",
      embedding: { provider: "ollama", model: "bge-m3", rerank: { baseUrl: "http://localhost:8080" } },
    });
    assert.equal(config?.embedding?.rerank?.baseUrl, "http://localhost:8080");
  });

  it("rerank 缺 provider 与 baseUrl 报错", () => {
    assert.throws(
      () =>
        parse({
          enabled: true,
          provider: "edgeclaw",
          embedding: { provider: "ollama", model: "bge-m3", rerank: { model: "x" } },
        }),
      (error: unknown) => error instanceof PilotConfigError && error.code === "CONFIG_MEMORY_RERANK_INVALID",
    );
  });

  it("rerank 未知字段 warning + 未知 provider warning", () => {
    const { diagnostics } = parse(
      {
        enabled: true,
        provider: "edgeclaw",
        embedding: { provider: "ollama", model: "bge-m3", rerank: { provider: "ghost", nonsense: 1 } },
      },
      modelConfig,
    );
    assert.ok(diagnostics.some(d => d.code === "CONFIG_MEMORY_RERANK_PROVIDER_NOT_FOUND"));
    assert.ok(diagnostics.some(d => d.path === "memory.embedding.rerank.nonsense"));
  });
});
