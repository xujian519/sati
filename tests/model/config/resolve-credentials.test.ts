import test from "node:test";
import assert from "node:assert/strict";
import { resolveApiKey } from "../../../src/model/config/resolveCredentials.js";
import { ModelConfigError } from "../../../src/model/protocol/errors.js";

test("resolves api key from environment reference", () => {
  assert.equal(resolveApiKey("${OPENAI_API_KEY}", { OPENAI_API_KEY: "sk-test" }), "sk-test");
});

test("keeps literal api key values", () => {
  assert.equal(resolveApiKey("sk-literal", {}), "sk-literal");
});

test("rejects missing environment reference", () => {
  assert.throws(
    () => resolveApiKey("${MISSING_KEY}", {}),
    (error) => error instanceof ModelConfigError && error.code === "missing_api_key",
  );
});
