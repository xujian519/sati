import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../../../src/model/index.js";
import { parseRouterConfig } from "../../../src/router/config/parseRouterConfig.js";

/** 最小可用的 modelConfig：provider p1 声明 models 键（值仅需占位）。 */
function modelConfigWith(models: Record<string, unknown>): ModelConfig {
  return {
    providers: {
      p1: {
        id: "p1",
        protocol: "openai",
        url: "https://example.com",
        apiKey: "k",
        headers: {},
        models,
      },
    },
  } as unknown as ModelConfig;
}

test("parseRouterConfig：media 键解析为多模态候选", () => {
  const result = parseRouterConfig({ fallback: { media: ["p1/vision"] } }, modelConfigWith({ vision: {} }));
  assert.ok(result.config);
  assert.deepEqual(result.config?.fallback?.media, [{ id: "p1/vision", provider: "p1", model: "vision" }]);
  assert.ok(
    result.diagnostics.every(d => d.severity !== "fatal"),
    "media 合法数组不应产生 fatal diagnostic",
  );
});

test("parseRouterConfig：media 非数组报 fatal", () => {
  const result = parseRouterConfig({ fallback: { media: "p1/vision" } }, modelConfigWith({ vision: {} }));
  assert.ok(result.diagnostics.some(d => d.code === "ROUTER_FALLBACK_MEDIA_NOT_ARRAY" && d.severity === "fatal"));
});

test("parseRouterConfig：media 空数组不写入", () => {
  const result = parseRouterConfig({ fallback: { media: [] } }, modelConfigWith({ vision: {} }));
  assert.ok(result.config);
  assert.equal(result.config?.fallback?.media, undefined);
});

test("parseRouterConfig：media 引用未知 provider 报 fatal", () => {
  const result = parseRouterConfig({ fallback: { media: ["unknown/x"] } }, modelConfigWith({ vision: {} }));
  assert.ok(result.diagnostics.some(d => d.code === "ROUTER_REF_PROVIDER_NOT_FOUND"));
});

test("parseRouterConfig：media 与场景键共存且互不干扰", () => {
  const result = parseRouterConfig(
    { fallback: { media: ["p1/vision"], default: ["p1/m1"] } },
    modelConfigWith({ vision: {}, m1: {} }),
  );
  assert.ok(result.config);
  assert.deepEqual(result.config?.fallback?.media, [{ id: "p1/vision", provider: "p1", model: "vision" }]);
  assert.deepEqual(result.config?.fallback?.default, [{ id: "p1/m1", provider: "p1", model: "m1" }]);
});
