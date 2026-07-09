import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG } from "../../src/model/catalog/providers.js";

test("builtin model output caps stay below context windows", () => {
  for (const [providerId, provider] of Object.entries(PROVIDER_CATALOG)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const { maxContextTokens, maxOutputTokens } = model.capabilities;
      assert.ok(
        maxOutputTokens < maxContextTokens,
        `${providerId}/${modelId} maxOutputTokens (${maxOutputTokens}) must be below maxContextTokens (${maxContextTokens})`,
      );
    }
  }
});
