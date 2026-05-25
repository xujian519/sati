import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedDevicePath } from "../../src/tool/builtin/filesystem/fileTypeSafety.js";

// ---------------------------------------------------------------------------
// Windows device paths
// ---------------------------------------------------------------------------

test("blocks \\\\.\\PhysicalDrive0", () => {
  assert.equal(isBlockedDevicePath("\\\\.\\PhysicalDrive0"), true);
});

test("blocks \\\\.\\PhysicalDrive1", () => {
  assert.equal(isBlockedDevicePath("\\\\.\\PhysicalDrive1"), true);
});

test("blocks \\\\.\\C: raw volume access", () => {
  assert.equal(isBlockedDevicePath("\\\\.\\C:"), true);
});

test("blocks \\\\?\\C: extended path prefix", () => {
  assert.equal(isBlockedDevicePath("\\\\?\\C:"), true);
});

test("blocks bare CON device name", () => {
  assert.equal(isBlockedDevicePath("CON"), true);
});

test("blocks bare NUL device name", () => {
  assert.equal(isBlockedDevicePath("NUL"), true);
});

test("blocks bare PRN device name", () => {
  assert.equal(isBlockedDevicePath("PRN"), true);
});

test("blocks bare AUX device name", () => {
  assert.equal(isBlockedDevicePath("AUX"), true);
});

test("blocks COM1 device name", () => {
  assert.equal(isBlockedDevicePath("COM1"), true);
});

test("blocks LPT1 device name", () => {
  assert.equal(isBlockedDevicePath("LPT1"), true);
});

test("blocks CON.txt (device name with extension)", () => {
  assert.equal(isBlockedDevicePath("CON.txt"), true);
});

test("blocks NUL.log (device name with extension)", () => {
  assert.equal(isBlockedDevicePath("NUL.log"), true);
});

test("blocks lowercase nul device name", () => {
  assert.equal(isBlockedDevicePath("nul"), true);
});

test("blocks mixed-case Con device name", () => {
  assert.equal(isBlockedDevicePath("Con"), true);
});

// ---------------------------------------------------------------------------
// Unix device paths still blocked
// ---------------------------------------------------------------------------

test("still blocks /dev/zero", () => {
  assert.equal(isBlockedDevicePath("/dev/zero"), true);
});

test("still blocks /dev/urandom", () => {
  assert.equal(isBlockedDevicePath("/dev/urandom"), true);
});

test("still blocks /proc/self/fd/0", () => {
  assert.equal(isBlockedDevicePath("/proc/self/fd/0"), true);
});

// ---------------------------------------------------------------------------
// Normal paths are NOT blocked
// ---------------------------------------------------------------------------

test("allows normal file path", () => {
  assert.equal(isBlockedDevicePath("C:\\Users\\test\\README.md"), false);
});

test("allows unix normal path", () => {
  assert.equal(isBlockedDevicePath("/home/user/project/index.ts"), false);
});

test("allows file named CONSOLE (not a reserved name)", () => {
  assert.equal(isBlockedDevicePath("CONSOLE"), false);
});

test("allows file containing CON in longer name", () => {
  assert.equal(isBlockedDevicePath("CONTENTS.md"), false);
});
