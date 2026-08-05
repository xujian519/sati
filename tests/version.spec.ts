import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_VERSION, resolveAppVersion } from "../src/version.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-version-"));
}

test("resolveAppVersion returns the version of the nearest sati package.json", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sati", version: "9.9.9" }));
    assert.equal(resolveAppVersion(dir), "9.9.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion skips a package.json whose name is not sati and keeps walking up", () => {
  const root = tempDir();
  const deep = join(root, "sub", "deep");
  mkdirSync(deep, { recursive: true });
  try {
    writeFileSync(join(root, "sub", "package.json"), JSON.stringify({ name: "other-pkg", version: "1.2.3" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sati", version: "8.8.8" }));
    assert.equal(resolveAppVersion(deep), "8.8.8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAppVersion returns the 0.0.0 sentinel when no sati package.json exists above", () => {
  const dir = tempDir();
  try {
    assert.equal(resolveAppVersion(dir), "0.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion skips a malformed package.json and keeps walking up", () => {
  const root = tempDir();
  const deep = join(root, "mid", "deep");
  mkdirSync(deep, { recursive: true });
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sati", version: "7.7.7" }));
    writeFileSync(join(root, "mid", "package.json"), "{ not valid json");
    assert.equal(resolveAppVersion(deep), "7.7.7");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("APP_VERSION resolves to a real semver version in this repo", () => {
  assert.notEqual(APP_VERSION, "0.0.0");
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});
