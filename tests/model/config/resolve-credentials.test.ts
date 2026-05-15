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

test("trims whitespace from literal api keys", () => {
  // Reproduces the "无效的令牌" footgun where a YAML quoted string carried
  // a leading space (apiKey: " sk-...") and Authorization became
  // "Bearer  sk-..." with a double space.
  assert.equal(resolveApiKey(" sk-literal", {}), "sk-literal");
  assert.equal(resolveApiKey("sk-literal\n", {}), "sk-literal");
  assert.equal(resolveApiKey("\t sk-literal \t", {}), "sk-literal");
});

test("trims whitespace from env-resolved api keys", () => {
  assert.equal(
    resolveApiKey("${OPENAI_API_KEY}", { OPENAI_API_KEY: " sk-from-env\n" }),
    "sk-from-env",
  );
});

test("recognises ${VAR} syntax even when wrapped in whitespace", () => {
  assert.equal(
    resolveApiKey("  ${OPENAI_API_KEY}  ", { OPENAI_API_KEY: "sk-test" }),
    "sk-test",
  );
});

test("rejects whitespace-only api keys", () => {
  assert.throws(
    () => resolveApiKey("   ", {}),
    (error) => error instanceof ModelConfigError && error.code === "missing_api_key",
  );
  assert.throws(
    () => resolveApiKey("${WHITESPACE_KEY}", { WHITESPACE_KEY: "   \t\n" }),
    (error) => error instanceof ModelConfigError && error.code === "missing_api_key",
  );
});
