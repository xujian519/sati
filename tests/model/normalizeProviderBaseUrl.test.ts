import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProviderBaseUrl } from "../../src/model/normalizeProviderBaseUrl.js";

test("normalizeProviderBaseUrl trims trailing slash", () => {
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
});

test("normalizeProviderBaseUrl strips userinfo query and fragment", () => {
  assert.equal(
    normalizeProviderBaseUrl("http://user:pass@host.example.com/path?q=secret#frag"),
    "http://host.example.com/path",
  );
});

test("normalizeProviderBaseUrl rejects non-http schemes", () => {
  assert.equal(normalizeProviderBaseUrl("ftp://files.example.com"), undefined);
});

test("normalizeProviderBaseUrl rejects empty input", () => {
  assert.equal(normalizeProviderBaseUrl(""), undefined);
  assert.equal(normalizeProviderBaseUrl("   "), undefined);
});

test("normalizeProviderBaseUrl rejects invalid url", () => {
  assert.equal(normalizeProviderBaseUrl("not-a-url"), undefined);
});
