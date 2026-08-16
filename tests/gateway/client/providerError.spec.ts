import assert from "node:assert/strict";
import test from "node:test";
import {
  providerErrorFromModelError,
  providerErrorFromRecord,
  stringifyProviderRaw,
} from "../../../src/gateway/client/providerError.js";

test("providerError: fromModelError 全字段映射", () => {
  const err = {
    provider: "anthropic",
    protocol: "anthropic",
    status: 429,
    code: "rate_limit_error",
    message: "too many requests",
    retryable: true,
    raw: { retryAfter: 5 },
  } as const;
  const out = providerErrorFromModelError(err);
  assert.equal(out.provider, "anthropic");
  assert.equal(out.status, 429);
  assert.equal(out.code, "rate_limit_error");
  assert.match(out.raw ?? "", /retryAfter/);
});

test("providerError: fromRecord 全空返回 undefined", () => {
  assert.equal(providerErrorFromRecord({}), undefined);
  assert.equal(providerErrorFromRecord({ foo: "bar" }), undefined);
});

test("providerError: fromRecord 部分字段映射", () => {
  const out = providerErrorFromRecord({ provider: "openai", status: 401, raw: { x: 1 } });
  assert.ok(out);
  assert.equal(out.provider, "openai");
  assert.equal(out.status, 401);
  assert.equal(out.code, undefined);
});

test("providerError: stringifyProviderRaw 超长截断 1200 字符", () => {
  const out = stringifyProviderRaw("x".repeat(2_000));
  assert.ok(out !== undefined);
  assert.ok(out.length <= 1_200 + 1, `应截断到 ≤1200+省略号，实际 ${out.length}`);
  assert.match(out!, /…$/);
  assert.equal(stringifyProviderRaw(null), undefined);
  assert.equal(stringifyProviderRaw(undefined), undefined);
});
