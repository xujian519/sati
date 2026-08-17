import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeText, scoreMatch } from "../src/core/utils/text.js";
describe("smoke", () => {
  it("normalizeText 折叠空白并 trim", () => {
    assert.equal(normalizeText("  a   b\n\tc  "), "a b c");
    assert.equal(normalizeText("single"), "single");
  });
  it("scoreMatch 全等 1 分 / 无匹配 0 分", () => {
    assert.equal(scoreMatch("专利", "专利"), 1);
    assert.equal(scoreMatch("专利", "完全无关内容"), 0);
  });
});
