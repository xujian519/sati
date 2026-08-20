import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNonNegativeInt,
  parsePositiveInt,
  readBoolEnv,
  readDurationEnvMs,
  readIntEnv,
  readNonNegativeIntEnv,
} from "../../src/shared/env/index.js";

test("parsePositiveInt parses positive integers", () => {
  assert.equal(parsePositiveInt("42"), 42);
  assert.equal(parsePositiveInt("  7  "), 7);
  // parseInt 在首个非数字字符处截断，语义与旧 createLocalGateway.readPositiveIntegerEnv 一致
  assert.equal(parsePositiveInt("1e3"), 1);
  assert.equal(parsePositiveInt("42abc"), 42);
});

test("parsePositiveInt returns undefined for invalid input", () => {
  assert.equal(parsePositiveInt(undefined), undefined);
  assert.equal(parsePositiveInt(""), undefined);
  assert.equal(parsePositiveInt("0"), undefined);
  assert.equal(parsePositiveInt("-3"), undefined);
  assert.equal(parsePositiveInt("abc"), undefined);
  // "0x10" 按 radix 10 解析为 0，不满足 >0
  assert.equal(parsePositiveInt("0x10"), undefined);
});

test("parseNonNegativeInt accepts zero and rejects negatives", () => {
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(parseNonNegativeInt("5"), 5);
  assert.equal(parseNonNegativeInt(" 3 "), 3);
  assert.equal(parseNonNegativeInt(undefined), undefined);
  assert.equal(parseNonNegativeInt("-1"), undefined);
  assert.equal(parseNonNegativeInt("abc"), undefined);
});

test("readIntEnv falls back when parsing fails", () => {
  assert.equal(readIntEnv("42", 10), 42);
  assert.equal(readIntEnv(undefined, 10), 10);
  assert.equal(readIntEnv("0", 10), 10);
  assert.equal(readIntEnv("junk", 10), 10);
});

test("readNonNegativeIntEnv falls back when parsing fails", () => {
  assert.equal(readNonNegativeIntEnv("0", 3), 0);
  assert.equal(readNonNegativeIntEnv("-1", 3), 3);
  assert.equal(readNonNegativeIntEnv(undefined, 3), 3);
});

test("readBoolEnv maps 0/false/off to false and 1/true/on to true", () => {
  for (const raw of ["0", "false", "off"]) {
    assert.equal(readBoolEnv(raw, true), false, raw);
  }
  for (const raw of ["1", "true", "on"]) {
    assert.equal(readBoolEnv(raw, false), true, raw);
  }
  assert.equal(readBoolEnv("  TRUE  ", false), true);
});

test("readBoolEnv falls back for unknown values", () => {
  assert.equal(readBoolEnv(undefined, true), true);
  assert.equal(readBoolEnv("", false), false);
  assert.equal(readBoolEnv("yes", true), true);
  assert.equal(readBoolEnv("2", false), false);
});

test("readDurationEnvMs parses numbers including scientific notation", () => {
  assert.equal(readDurationEnvMs("1000", 1), 1000);
  assert.equal(readDurationEnvMs("2", 500), 1000);
  assert.equal(readDurationEnvMs("1e3", 1), 1000);
  assert.equal(readDurationEnvMs("0.5", 1000), 500);
});

test("readDurationEnvMs returns undefined for unset or invalid values", () => {
  assert.equal(readDurationEnvMs(undefined, 1), undefined);
  assert.equal(readDurationEnvMs("", 1), undefined);
  assert.equal(readDurationEnvMs("   ", 1), undefined);
  assert.equal(readDurationEnvMs("abc", 1), undefined);
  assert.equal(readDurationEnvMs("0", 1), undefined);
  assert.equal(readDurationEnvMs("-5", 1), undefined);
  assert.equal(readDurationEnvMs("Infinity", 1), undefined);
});
