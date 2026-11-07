import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asFlooredPositiveInteger,
  asNonEmptyString,
  asPositiveNumber,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isPositiveInteger,
  isPositiveNumber,
} from "../../src/shared/configValidators.js";

describe("config validators", () => {
  it("rejects non-finite and non-positive numbers", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      assert.equal(isPositiveNumber(value), false);
    }
    assert.equal(isPositiveNumber(0.5), true);
    assert.equal(asPositiveNumber(-1), undefined);
    assert.equal(asPositiveNumber(0.5), 0.5);
  });

  it("separates integer from decimal", () => {
    assert.equal(isPositiveInteger(3), true);
    assert.equal(isPositiveInteger(3.5), false);
    assert.equal(isNonNegativeInteger(0), true);
    assert.equal(isNonNegativeInteger(-0.5), false);
    assert.equal(isNonNegativeNumber(0), true);
  });

  it("trims non-empty strings and rejects blank input", () => {
    assert.equal(asNonEmptyString("  hello  "), "hello");
    assert.equal(asNonEmptyString("   "), undefined);
    assert.equal(asNonEmptyString(42), undefined);
  });

  it("floors positive numbers for external tool positions", () => {
    assert.equal(asFlooredPositiveInteger(12.9), 12);
    assert.equal(asFlooredPositiveInteger(0.5), undefined);
    assert.equal(asFlooredPositiveInteger(Number.NaN), undefined);
  });
});
