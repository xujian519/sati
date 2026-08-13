import test from "node:test";
import assert from "node:assert/strict";
import {
  createLongTimeoutOptions,
  getProxyUrl,
  installGlobalProxy,
  isProxyConnectionError,
  reinstallGlobalProxy,
} from "../../src/cli/proxy.js";

test("getProxyUrl follows the priority chain", () => {
  assert.equal(getProxyUrl({}), undefined);
  assert.equal(getProxyUrl({ http_proxy: "http://h" }), "http://h");
  assert.equal(getProxyUrl({ http_proxy: "http://h", HTTP_PROXY: "http://H" }), "http://h");
  assert.equal(getProxyUrl({ https_proxy: "https://s", http_proxy: "http://h" }), "https://s");
  assert.equal(getProxyUrl({ HTTPS_PROXY: "https://S", https_proxy: "https://s" }), "https://s");
  assert.equal(getProxyUrl({ PILOTDECK_PROXY: "http://legacy", HTTPS_PROXY: "https://S" }), "http://legacy");
  assert.equal(getProxyUrl({ SATI_PROXY: "http://brand", PILOTDECK_PROXY: "http://legacy" }), "http://brand");
});

test("createLongTimeoutOptions returns bounded transport options", () => {
  const options = createLongTimeoutOptions();
  assert.equal(typeof options.headersTimeout, "number");
  assert.equal(typeof options.bodyTimeout, "number");
  assert.equal(typeof options.connections, "number");
  assert.equal(typeof options.keepAliveTimeout, "number");
  assert.ok(options.headersTimeout > 0);
  assert.ok(options.connections > 0);
});

test("installGlobalProxy with no proxy configured returns undefined", async () => {
  // The process env may contain proxy vars in CI; force an explicit env read
  // by calling installGlobalProxy with a falsy explicit URL is not possible,
  // so guard: if no env proxy is present, direct dispatcher is installed.
  const result = await installGlobalProxy(undefined, undefined);
  assert.equal(result, undefined);
});

test("reinstallGlobalProxy with undefined removes the proxy", async () => {
  const result = await reinstallGlobalProxy(undefined);
  assert.equal(result, undefined);
});

test("isProxyConnectionError walks the cause chain for ECONNREFUSED", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9981"), { code: "ECONNREFUSED" }),
  });
  assert.equal(isProxyConnectionError(err), true);
});

test("isProxyConnectionError rejects DNS and non-network errors", () => {
  const dnsError = new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.test"), { code: "ENOTFOUND" }),
  });
  assert.equal(isProxyConnectionError(dnsError), false);
  assert.equal(isProxyConnectionError(new Error("boom")), false);
  assert.equal(isProxyConnectionError(undefined), false);
});
