import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";
import { NetworkFetchError } from "../../../src/network/fetch.js";

function codeFor(message: string): string {
  return normalizeModelError("test", "openai", new Error(message)).code;
}

test("normalizeModelError classifies common network failures", () => {
  assert.equal(codeFor("getaddrinfo ENOTFOUND api.test"), "dns_error");
  assert.equal(codeFor("read ECONNRESET"), "connection_reset");
  assert.equal(codeFor("connect ECONNREFUSED 127.0.0.1:443"), "connection_refused");
  assert.equal(codeFor("certificate has expired"), "tls_error");
  assert.equal(codeFor("proxy CONNECT failed"), "proxy_error");
});

test("stream-interruption messages map to retryable timeout, not provider_error", () => {
  // openai adapter 流内 error chunk 的 canonical 对象直接归一化：
  // "terminated" 应归为 timeout（可重试），而非保留未分类的 provider_error。
  const error = normalizeModelError("test", "openai", {
    provider: "test",
    protocol: "openai",
    code: "provider_error",
    message: "terminated",
    retryable: false,
    raw: {},
  });

  assert.equal(error.code, "timeout");
  assert.equal(error.retryable, true);
});

test("non-network messages are not misclassified as timeout", () => {
  // 计费错误消息若含 "terminated" 字样（如 "Insufficient balance. Request terminated."），
  // 语义分类仍应优先计费，不得被网络模式反转成可重试。
  const error = normalizeModelError("test", "openai", {
    provider: "test",
    protocol: "openai",
    code: "provider_error",
    message: "Insufficient balance. Request terminated.",
    retryable: false,
    raw: {},
  });

  assert.equal(error.code, "billing");
  assert.equal(error.retryable, false);
});

test("NetworkFetchError 的 transport/abort 归入独立错误码", () => {
  const transport = normalizeModelError(
    "test",
    "openai",
    new NetworkFetchError("network_fetch_failed", "fetch failed"),
  );
  assert.equal(transport.code, "transport_error");
  assert.equal(transport.retryable, true);

  const aborted = normalizeModelError("test", "openai", new NetworkFetchError("network_abort", "request aborted"));
  assert.equal(aborted.code, "aborted");
  assert.equal(aborted.retryable, false);
});

test("cause 中的网络错误被递归归一", () => {
  const nested = new Error("provider request failed", {
    cause: new NetworkFetchError("network_dns_error", "getaddrinfo ENOTFOUND api.test"),
  });
  assert.equal(normalizeModelError("test", "openai", nested).code, "dns_error");
});

test("普通 AbortError 与 fetch failed 消息也能分类", () => {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  const aborted = normalizeModelError("test", "openai", abortError);
  assert.equal(aborted.code, "aborted");
  assert.equal(aborted.retryable, false);

  assert.equal(codeFor("TypeError: fetch failed"), "transport_error");
});
