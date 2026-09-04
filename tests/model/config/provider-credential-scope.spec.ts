import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCatalogCredential,
  resolveDefaultProviderUrl,
} from "../../../src/model/config/providerCredentialScope.js";

const anthropicCatalog = { protocol: "anthropic" as const, defaultUrl: "https://api.anthropic.com" };
const googleCatalog = { protocol: "google" as const, defaultUrl: "https://generativelanguage.googleapis.com" };

test("resolveDefaultProviderUrl keeps google openai-compatible exception", () => {
  assert.equal(
    resolveDefaultProviderUrl("google", "openai", googleCatalog.defaultUrl),
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
  assert.equal(resolveDefaultProviderUrl("google", "google", googleCatalog.defaultUrl), googleCatalog.defaultUrl);
  assert.equal(
    resolveDefaultProviderUrl("anthropic", "anthropic", "https://api.anthropic.com"),
    "https://api.anthropic.com",
  );
  assert.equal(resolveDefaultProviderUrl("custom", "openai", undefined), undefined);
});

test("canUseCatalogCredential is false without a catalog entry", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "custom",
      protocol: "openai",
      url: "https://api.deepseek.com/v1",
      catalog: undefined,
    }),
    false,
  );
});

test("canUseCatalogCredential is true on the catalog endpoint", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "anthropic",
      protocol: "anthropic",
      url: "https://api.anthropic.com",
      catalog: anthropicCatalog,
    }),
    true,
  );
});

test("canUseCatalogCredential normalizes trailing slashes and host case", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "anthropic",
      protocol: "anthropic",
      url: "HTTPS://API.ANTHROPIC.COM//",
      catalog: anthropicCatalog,
    }),
    true,
  );
});

test("canUseCatalogCredential is false on a custom url", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "anthropic",
      protocol: "anthropic",
      url: "https://evil-proxy.example.com",
      catalog: anthropicCatalog,
    }),
    false,
  );
});

test("canUseCatalogCredential is false when protocol diverges from catalog", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "anthropic",
      protocol: "openai",
      url: "https://api.anthropic.com",
      catalog: anthropicCatalog,
    }),
    false,
  );
});

test("google openai-compatible endpoint stays inside the credential scope", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "google",
      protocol: "openai",
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
      catalog: googleCatalog,
    }),
    true,
  );
});

test("google openai protocol on any other url leaves the credential scope", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "google",
      protocol: "openai",
      url: "https://proxy.example.com/v1",
      catalog: googleCatalog,
    }),
    false,
  );
});

test("google exception does not leak to other providers", () => {
  assert.equal(
    canUseCatalogCredential({
      providerId: "not-google",
      protocol: "openai",
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
      catalog: { protocol: "openai", defaultUrl: "https://api.openai.com/v1" },
    }),
    false,
  );
});
