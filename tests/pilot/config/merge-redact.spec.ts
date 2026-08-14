import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfigSources } from "../../../src/pilot/config/merge.js";
import { redactConfig } from "../../../src/pilot/config/redact.js";
import { sha256, stableStringify } from "../../../src/pilot/config/hash.js";

test("mergeConfigSources merges multiple sources in order", () => {
  const merged = mergeConfigSources({ a: 1, nested: { x: 1 } }, { b: 2, nested: { y: 2 } }, { nested: { z: 3 } });
  assert.deepEqual(merged, { a: 1, b: 2, nested: { x: 1, y: 2, z: 3 } });
});

test("mergeConfigSources deep-merges nested records only", () => {
  const merged = mergeConfigSources({ nested: { x: 1 } }, { nested: { x: 2, y: 3 }, arr: [1, 2] }, { arr: [3] });
  assert.deepEqual(merged, { nested: { x: 2, y: 3 }, arr: [3] }); // arrays replaced wholesale
});

test("mergeConfigSources skips undefined and resets on non-record", () => {
  assert.deepEqual(mergeConfigSources(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeConfigSources({ a: 1 }, "nope", { b: 2 }), { b: 2 });
});

test("sha256 returns deterministic 64-char hex", () => {
  const out = sha256("sati");
  assert.match(out, /^[0-9a-f]{64}$/);
  assert.equal(sha256("sati"), sha256("sati"));
  assert.notEqual(sha256("sati"), sha256("sati2"));
});

test("stableStringify sorts keys and handles nesting", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ a: { y: 1, x: 2 } }), '{"a":{"x":2,"y":1}}');
  assert.equal(stableStringify([3, { b: 1, a: 2 }, "s"]), '[3,{"a":2,"b":1},"s"]');
  assert.equal(stableStringify("v"), '"v"');
  assert.equal(stableStringify(42), "42");
  assert.equal(stableStringify(null), "null");
  // Key order does not affect output.
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("redactConfig redacts secret-like keys recursively", () => {
  const out = redactConfig({
    apiKey: "sk-123",
    token: "tok",
    password: "pw",
    secret: "sec",
    credential: "cred",
    authorization: "Bearer x",
    cookie: "session=1",
    model: "grok",
    nested: { clientSecret: "s", safe: "keep" },
    list: [{ apiKey: "k2" }, "plain"],
  }) as Record<string, unknown>;
  assert.equal(out.apiKey, "<redacted>");
  assert.equal(out.token, "<redacted>");
  assert.equal(out.password, "<redacted>");
  assert.equal(out.secret, "<redacted>");
  assert.equal(out.credential, "<redacted>");
  assert.equal(out.authorization, "<redacted>");
  assert.equal(out.cookie, "<redacted>");
  assert.equal(out.model, "grok");
  assert.deepEqual(out.nested, { clientSecret: "<redacted>", safe: "keep" });
  assert.deepEqual(out.list, [{ apiKey: "<redacted>" }, "plain"]);
});

test("redactConfig preserves non-secret values untouched", () => {
  assert.deepEqual(redactConfig({ port: 19789, enabled: false }), { port: 19789, enabled: false });
  assert.equal(redactConfig("plain"), "plain");
});

test("redactConfig：词元+key 命名（secret_key/accessKey/privateKey）同样脱敏", () => {
  const out = redactConfig({
    secret_key: "aws-secret",
    accessKey: "aws-access",
    privateKey: "pem",
    clientKey: "ck",
    refreshKey: "rk",
  }) as Record<string, unknown>;
  assert.equal(out.secret_key, "<redacted>");
  assert.equal(out.accessKey, "<redacted>");
  assert.equal(out.privateKey, "<redacted>");
  assert.equal(out.clientKey, "<redacted>");
  assert.equal(out.refreshKey, "<redacted>");
});

test("redactConfig：非敏感命名（来源/配置字段）保持原样", () => {
  const out = redactConfig({
    apiKeySource: "env",
    modelConfig: "m",
    endpoint: "https://x",
    publicKey: "pub",
    monkey: "m",
  }) as Record<string, unknown>;
  assert.equal(out.apiKeySource, "env");
  assert.equal(out.modelConfig, "m");
  assert.equal(out.endpoint, "https://x");
  assert.equal(out.publicKey, "pub");
  assert.equal(out.monkey, "m");
});

test("redactConfig：apiKeyRaw 的 ${VAR} 环境引用保留变量名，字面量才脱敏", () => {
  const out = redactConfig({
    model: {
      providers: {
        openai: {
          apiKeyRaw: "${OPENAI_API_KEY}",
          apiKey: "${OPENAI_API_KEY}",
        },
        anthropic: {
          apiKeyRaw: "sk-ant-literal",
        },
      },
    },
  }) as { model: { providers: Record<string, Record<string, unknown>> } };
  const openai = out.model.providers.openai;
  const anthropic = out.model.providers.anthropic;
  assert.equal(openai.apiKeyRaw, "${OPENAI_API_KEY}");
  assert.equal(openai.apiKey, "${OPENAI_API_KEY}");
  assert.equal(anthropic.apiKeyRaw, "<redacted>");
});
