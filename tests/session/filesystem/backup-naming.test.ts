import test from "node:test";
import assert from "node:assert/strict";
import { getBackupFileName, parseBackupVersion } from "../../../src/session/index.js";

test("C4.F4 getBackupFileName produces sha256(filePath).slice(0, 16) + '@v' + version", () => {
  const name = getBackupFileName("/abs/path/to/file.ts", 3);
  assert.match(name, /^[0-9a-f]{16}@v3$/);
});

test("C4.F4 same path → same hash; different versions → different name", () => {
  const v1 = getBackupFileName("/path/x.ts", 1);
  const v2 = getBackupFileName("/path/x.ts", 2);
  assert.notEqual(v1, v2);
  assert.equal(v1.split("@")[0], v2.split("@")[0]);
});

test("C4.F4 different paths → different hashes (collision-resistant)", () => {
  const a = getBackupFileName("/a.ts", 1);
  const b = getBackupFileName("/b.ts", 1);
  assert.notEqual(a.split("@")[0], b.split("@")[0]);
});

test("C4.parseBackupVersion round-trips; rejects malformed", () => {
  assert.equal(parseBackupVersion(getBackupFileName("/x.ts", 7)), 7);
  assert.equal(parseBackupVersion("nohash@vabc"), null);
  assert.equal(parseBackupVersion("plain-name"), null);
  assert.equal(parseBackupVersion(getBackupFileName("/x.ts", 0)), 0);
});
