import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeText } from "../src/core/utils/text.js";
describe("smoke", () => {
  it("runs", () => {
    assert.equal(typeof normalizeText, "function");
  });
});
