import test from "node:test";
import assert from "node:assert/strict";
import { getBackupFileName, parseBackupVersion } from "../../../src/session/filesystem/backupNaming.js";

test("getBackupFileName derives a stable 16-hex hash with version suffix", () => {
  const first = getBackupFileName("/repo/src/a.ts", 3);
  const second = getBackupFileName("/repo/src/a.ts", 3);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{16}@v3$/);
});

test("getBackupFileName produces distinct names for distinct paths and versions", () => {
  assert.notEqual(getBackupFileName("/a.ts", 1), getBackupFileName("/b.ts", 1));
  assert.notEqual(getBackupFileName("/a.ts", 1), getBackupFileName("/a.ts", 2));
});

test("getBackupFileName is deterministic across calls for the same input", () => {
  assert.equal(getBackupFileName("/repo/b.ts", 7), getBackupFileName("/repo/b.ts", 7));
});

test("parseBackupVersion extracts the trailing version", () => {
  assert.equal(parseBackupVersion("abcdef0123456789@v0"), 0);
  assert.equal(parseBackupVersion("abcdef0123456789@v42"), 42);
});

test("parseBackupVersion returns null for malformed names", () => {
  assert.equal(parseBackupVersion("abcdef0123456789"), null);
  assert.equal(parseBackupVersion("abcdef0123456789@v"), null);
  assert.equal(parseBackupVersion("abcdef0123456789@v-1"), null);
  assert.equal(parseBackupVersion("abcdef0123456789@v1.5"), null);
  assert.equal(parseBackupVersion("abcdef0123456789@v999999999999999999999999"), null);
  assert.equal(parseBackupVersion(""), null);
});

test("parseBackupVersion round-trips with getBackupFileName", () => {
  for (const version of [0, 1, 10, 999]) {
    assert.equal(parseBackupVersion(getBackupFileName("/x/y.ts", version)), version);
  }
});
