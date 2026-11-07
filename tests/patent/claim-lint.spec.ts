import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lintClaimText, lintClaims, parseReferenceNumbers } from "../../src/patent/claim-lint/index.js";

const INDEPENDENT = "1. 一种数据处理方法，其特征在于，包括：获取输入数据；对所述输入数据进行处理，得到处理结果。";

describe("claim-lint", () => {
  it("passes a clean two-claim set", () => {
    const result = lintClaims([INDEPENDENT, "2. 根据权利要求1所述的数据处理方法，其特征在于，所述处理包括降噪。"]);
    assert.equal(result.passed, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it("flags each uncertain term", () => {
    const cases: Array<[string, string]> = [
      ["1. 一种方法，其特征在于，包括A等。", "等"],
      ["1. 一种方法，其特征在于，温度约为50℃。", "约"],
      ["1. 一种方法，其特征在于，采用适当的压力。", "适当"],
      ["1. 一种方法，其特征在于，可以采用A。", "可以"],
    ];
    for (const [claim, term] of cases) {
      const result = lintClaims([claim]);
      const issue = result.errors.find(item => item.rule === "uncertain-term");
      assert.ok(issue, `expected uncertain-term for ${term}`);
      assert.match(issue.message, new RegExp(term));
    }
  });

  it("does not treat 相等 / 约束 as uncertain terms", () => {
    const result = lintClaims(["1. 一种方法，其特征在于，第一参数与第二参数相等，且在约束条件下求解。"]);
    assert.equal(result.passed, true);
  });

  it("flags a reference to a missing earlier claim", () => {
    const result = lintClaims([INDEPENDENT, "2. 根据权利要求5所述的数据处理方法，其特征在于，还包括B。"]);
    assert.equal(result.passed, false);
    assert.equal(result.errors[0]?.rule, "reference-basis");
  });

  it("requires alternative wording for multiple dependencies", () => {
    const result = lintClaims([
      INDEPENDENT,
      "2. 根据权利要求1所述的数据处理方法，其特征在于，还包括A。",
      "3. 根据权利要求1和2所述的数据处理方法，其特征在于，还包括B。",
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(item => item.rule === "multiple-dependent-basis"));
  });

  it("rejects a multiple dependent claim as a basis", () => {
    const result = lintClaims([
      INDEPENDENT,
      "2. 根据权利要求1所述的数据处理方法，其特征在于，还包括A。",
      "3. 根据权利要求1或2所述的数据处理方法，其特征在于，还包括B。",
      "4. 根据权利要求3所述的数据处理方法，其特征在于，还包括C。",
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(item => item.rule === "multiple-dependent-basis" && item.claimNo === 4));
  });

  it("warns on inconsistent antecedent subject", () => {
    const result = lintClaims([
      "1. 一种数据处理方法，其特征在于，包括步骤A。",
      "2. 根据权利要求1所述的装置，其特征在于，还包括B。",
    ]);
    assert.equal(result.passed, true);
    assert.ok(result.warnings.some(item => item.rule === "antecedent-consistency"));
  });

  it("warns on pure functional limitation", () => {
    const result = lintClaims(["1. 一种装置，其特征在于，用于数据处理。"]);
    assert.equal(result.passed, true);
    assert.ok(result.warnings.some(item => item.rule === "functional-limitation"));
  });

  it("flags non-continuous numbering", () => {
    const result = lintClaims([
      "1. 一种数据处理方法，其特征在于，包括步骤A。",
      "3. 根据权利要求1所述的数据处理方法，其特征在于，还包括B。",
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(item => item.rule === "numbering-continuity"));
  });

  it("parses ranges and alternative references", () => {
    assert.deepEqual(parseReferenceNumbers("1-3"), { numbers: [1, 2, 3], alternative: false });
    assert.deepEqual(parseReferenceNumbers("1或2"), { numbers: [1, 2], alternative: true });
    assert.deepEqual(parseReferenceNumbers("１、２"), { numbers: [1, 2], alternative: false });
  });

  it("lints a full text block split by claim numbers", () => {
    const result = lintClaimText(
      [
        "1. 一种数据处理方法，其特征在于，包括步骤A。",
        "2. 根据权利要求1所述的数据处理方法，其特征在于，还包括B。",
      ].join("\n"),
    );
    assert.equal(result.passed, true);
    assert.equal(result.issues.length, 0);
  });
});
