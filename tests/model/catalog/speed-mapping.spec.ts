import assert from "node:assert/strict";
import test from "node:test";
import { inferModelSpeed } from "../../../src/model/catalog/speedMapping.js";
import { lookupCatalogModel } from "../../../src/model/catalog/lookup.js";
import { PROVIDER_CATALOG } from "../../../src/model/catalog/providers.js";

test("fast-tier name patterns map to fast", () => {
  for (const id of [
    "gpt-4o-mini",
    "gemini-3.6-flash",
    "qwen-turbo",
    "claude-haiku-3-5-20241022",
    "deepseek-v4-flash",
    "MiniMax-M2.7-highspeed",
    "doubao-1.5-lite",
    "glm-4.7-flashx",
  ]) {
    assert.equal(inferModelSpeed(id), "fast", id);
  }
});

test("deep-tier name patterns map to deep", () => {
  for (const id of [
    "qwen3.7-max",
    "claude-opus-5-20260801",
    "gemini-2.5-pro",
    "deepseek-r1",
    "deepseek-v4-pro",
    "o3-mini",
    "o4-mini",
    "seed-2.0-pro",
  ]) {
    assert.equal(inferModelSpeed(id), "deep", id);
  }
});

test("flagship names without tier markers map to balanced", () => {
  for (const id of ["gpt-4o", "gpt-5.5", "claude-sonnet-4.6", "kimi-k2.6", "glm-5.2", "qwen-plus", "gpt-5.6-sol"]) {
    assert.equal(inferModelSpeed(id), "balanced", id);
  }
});

test("explicit entry speed overrides name inference", () => {
  assert.equal(inferModelSpeed("gpt-4o-mini", "deep"), "deep");
  assert.equal(inferModelSpeed("qwen3.7-max", "fast"), "fast");
});

test("empty model id falls back to balanced", () => {
  assert.equal(inferModelSpeed(""), "balanced");
  assert.equal(inferModelSpeed("   "), "balanced");
});

test("every catalog model resolves to a defined speed tier", () => {
  // 遍历 catalog 全部模型：速度档三值必有（规则覆盖完备性冒烟）。
  let count = 0;
  for (const [providerId, provider] of Object.entries(PROVIDER_CATALOG)) {
    for (const modelId of Object.keys(provider.models)) {
      const speed = inferModelSpeed(modelId, lookupCatalogModel(providerId, modelId).model?.speed);
      assert.ok(speed === "fast" || speed === "balanced" || speed === "deep", `${providerId}/${modelId}`);
      count += 1;
    }
  }
  assert.ok(count > 50, `expected the full catalog to be swept, got ${count}`);
});
