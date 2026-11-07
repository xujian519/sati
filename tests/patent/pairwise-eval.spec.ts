import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReport, kendallTauB, loadPairwiseJsonl, type PairwiseItem } from "../../scripts/patent-pairwise-eval.js";

const ALIGNED: PairwiseItem[] = [
  { id: "1", score_a: 4, score_b: 3, preference: "a" },
  { id: "2", score_a: 3, score_b: 4, preference: "b" },
];

describe("pairwise Kendall τ-b", () => {
  it("returns τ=1 when model and human rankings agree", () => {
    const report = kendallTauB(ALIGNED);
    assert.equal(report.tau, 1);
    assert.equal(report.disagreements.length, 0);
    assert.equal(report.tiesModel, 0);
    assert.equal(report.tiesHuman, 0);
  });

  it("returns τ=-1 when rankings are perfectly reversed", () => {
    const reversed = ALIGNED.map(item => ({
      ...item,
      preference: item.preference === "a" ? "b" : item.preference === "b" ? "a" : "equal",
    })) satisfies PairwiseItem[];
    assert.equal(kendallTauB(reversed).tau, -1);
  });

  it("reports disagreements without failing", () => {
    const mixed: PairwiseItem[] = [
      { id: "x", score_a: 4, score_b: 3, preference: "b" },
      { id: "y", score_a: 3, score_b: 4, preference: "b" },
      { id: "z", score_a: 5, score_b: 2, preference: "a" },
    ];
    const report = kendallTauB(mixed);
    assert.equal(report.tau, 0.5);
    assert.equal(report.disagreements[0]?.id, "x");
    assert.match(formatReport(report, 0.8), /未达标/);
  });

  it("loads the committed sample fixtures", () => {
    const items = loadPairwiseJsonl("tests/patent/fixtures/pairwise/sample.jsonl");
    assert.equal(items.length, 10);
    assert.equal(kendallTauB(items).tau, 1);
  });
});
