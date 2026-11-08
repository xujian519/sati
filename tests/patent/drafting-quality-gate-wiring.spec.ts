/**
 * 起草 manifest 的撰写质量门接线（#830 M2 / M4）。
 *
 * 覆盖：四步链路（strategy → preview → draft → review → lint → coverage）的
 * 阶段顺序、claim_lint 的有界 retry 回退、claim_breadth 两阶段在位。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patentDraftingManifest } from "../../src/patent/workflow/manifests.js";

describe("起草 manifest 撰写质量门接线", () => {
  it("权要撰写四步在位：strategy → preview → draft → review → lint → coverage", () => {
    const ids = patentDraftingManifest.stages.map(stage => stage.id);
    const expected = [
      "claim_strategy",
      "claim_breadth_preview",
      "draft_claims",
      "claim_breadth_review",
      "claim_lint",
      "claim_coverage",
    ];
    let cursor = -1;
    for (const id of expected) {
      const index = ids.indexOf(id);
      assert.ok(index >= 0, `manifest 缺少阶段 ${id}`);
      assert.ok(index > cursor, `阶段 ${id} 顺序异常（应排在 ${expected.join(" → ")} 之后）`);
      cursor = index;
    }
  });

  it("claim_lint 阶段：声明有界 retry，error 回退 draft_claims", () => {
    const stage = patentDraftingManifest.stages.find(item => item.id === "claim_lint");
    assert.ok(stage, "缺少 claim_lint 阶段");
    assert.equal(stage.atom, "claim-lint");
    assert.equal(stage.retry?.whenOutputGaps, true);
    assert.equal(stage.retry?.rewindTo, "draft_claims");
    assert.equal(stage.retry?.maxRetries, 1);
  });

  it("claim_breadth 两阶段使用 claim-breadth 原子", () => {
    for (const id of ["claim_breadth_preview", "claim_breadth_review"]) {
      const stage = patentDraftingManifest.stages.find(item => item.id === id);
      assert.ok(stage, `缺少 ${id} 阶段`);
      assert.equal(stage.atom, "claim-breadth");
    }
  });

  it("claim_lint 位于 draft_claims 之后、claim_coverage 之前", () => {
    const ids = patentDraftingManifest.stages.map(stage => stage.id);
    assert.ok(ids.indexOf("claim_lint") > ids.indexOf("draft_claims"));
    assert.ok(ids.indexOf("claim_lint") < ids.indexOf("claim_coverage"));
  });

  it("回退目标 draft_claims 必须早于 claim_lint（回退语义成立）", () => {
    const ids = patentDraftingManifest.stages.map(stage => stage.id);
    assert.ok(ids.indexOf("draft_claims") < ids.indexOf("claim_lint"));
  });
});
