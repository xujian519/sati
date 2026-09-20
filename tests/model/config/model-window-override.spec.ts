/**
 * 窗口覆盖层在解析期的接线（issue #449）。
 *
 * 解析优先级：**config 显式声明 > 覆盖层（observed / probe）> catalog > 协议默认**。
 * 本文件锁定三件事：未注入覆盖层时行为与改动前逐字相同；覆盖层确实高于 catalog /
 * 协议默认；config 显式声明仍最高。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { lookupCatalogModel } from "../../../src/model/catalog/index.js";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";

const NOW = "2026-09-19T00:00:00.000Z";

function rawConfig(modelBody: Record<string, unknown> = {}, modelId = "custom-model") {
  return {
    providers: {
      openai: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "k",
        models: { [modelId]: modelBody },
      },
    },
  };
}

function probeEntry(maxContextTokens: number) {
  return { maxContextTokens, source: "probe" as const, updatedAt: NOW, via: "context_length" };
}

test("未注入覆盖层：回落到协议默认，且不产生 windowOverrides 段（零行为变更）", () => {
  const config = parseModelConfig(rawConfig());
  const model = config.providers.openai?.models["custom-model"];
  assert.equal(model?.capabilities.maxContextTokens, 128000);
  assert.equal(config.windowOverrides, undefined);
});

test("空覆盖层（{}）与未注入等价", () => {
  const config = parseModelConfig(rawConfig(), { windowOverrides: {} });
  assert.equal(config.providers.openai?.models["custom-model"]?.capabilities.maxContextTokens, 128000);
  assert.equal(config.windowOverrides, undefined);
});

test("覆盖层高于协议默认，并汇总命中项供 UI 标注来源", () => {
  const config = parseModelConfig(rawConfig(), {
    windowOverrides: { "openai/custom-model": probeEntry(262144) },
  });
  assert.equal(config.providers.openai?.models["custom-model"]?.capabilities.maxContextTokens, 262144);
  assert.deepEqual(Object.keys(config.windowOverrides ?? {}), ["openai/custom-model"]);
  assert.equal(config.windowOverrides?.["openai/custom-model"]?.source, "probe");
  assert.equal(config.windowOverrides?.["openai/custom-model"]?.via, "context_length");
});

test("覆盖层只影响命中的模型（未命中的模型保持原值）", () => {
  const raw = {
    providers: {
      openai: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "k",
        models: { hit: {}, miss: {} },
      },
    },
  };
  const config = parseModelConfig(raw, { windowOverrides: { "openai/hit": probeEntry(200000) } });
  assert.equal(config.providers.openai?.models.hit?.capabilities.maxContextTokens, 200000);
  assert.equal(config.providers.openai?.models.miss?.capabilities.maxContextTokens, 128000);
  assert.deepEqual(Object.keys(config.windowOverrides ?? {}), ["openai/hit"]);
});

test("覆盖层高于 catalog 命中值", () => {
  const catalog = lookupCatalogModel("openai", "gpt-4.1");
  assert.ok(catalog.model, "前置：openai/gpt-4.1 应在内置 catalog 中");
  const catalogWindow = catalog.model?.capabilities.maxContextTokens;
  const config = parseModelConfig(rawConfig({}, "gpt-4.1"), {
    windowOverrides: { "openai/gpt-4.1": probeEntry(262144) },
  });
  const resolved = config.providers.openai?.models["gpt-4.1"]?.capabilities.maxContextTokens;
  assert.equal(resolved, 262144);
  assert.notEqual(resolved, catalogWindow);
});

test("config 显式声明优先于覆盖层（用户填的数最可信）", () => {
  const config = parseModelConfig(rawConfig({ capabilities: { maxContextTokens: 96000 } }), {
    windowOverrides: { "openai/custom-model": probeEntry(262144) },
  });
  assert.equal(config.providers.openai?.models["custom-model"]?.capabilities.maxContextTokens, 96000);
  // 仍然记录命中（用户能在设置页看到"探测到 262144，但当前按 96000 生效"）。
  assert.equal(config.windowOverrides?.["openai/custom-model"]?.maxContextTokens, 262144);
});

test("覆盖层可只给输出上限（上下文那一维保持协议默认）", () => {
  const config = parseModelConfig(rawConfig(), {
    windowOverrides: {
      "openai/custom-model": { maxOutputTokens: 64000, source: "probe", updatedAt: NOW, via: "max_tokens" },
    },
  });
  const caps = config.providers.openai?.models["custom-model"]?.capabilities;
  assert.equal(caps?.maxOutputTokens, 64000);
  assert.equal(caps?.maxContextTokens, 128000);
});
