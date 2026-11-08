/**
 * A26.3 enablement 子图的锚点证据层（#830 R3）与金标信号透传（R1）。
 *
 * 覆盖：enablement 子图新增 anchor_evidence 确定性节点、锚点命中/未命中
 * 可区分、锚点证据注入 enablement 节点提示、金标 signals 透传不再被丢弃。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEnablementGraph, anchorSpecFeatures } from "../../src/patent/graph/domains/enablement.js";
import { parseDraftingGoldenJsonl } from "../../src/patent/evaluate/cases/disclosure-drafting.js";
import type { StageProvider } from "../../src/patent/atoms/handler.js";

const CORPUS = join(process.cwd(), "tests/patent/fixtures/drafting-golden/cases.jsonl");

const CLAIM = "1. 一种双层真空保温容器，其特征在于，包括内胆、外壳与真空隔热层。";
const SPEC = "本发明提供一种双层真空保温容器，包括内胆、外壳与真空隔热层。";

/** 记录 prompt 的 mock provider：用于断言锚点证据进入提示。 */
function recordingProvider(prompts: string[]): StageProvider {
  return {
    async callLLM(prompt: string): Promise<string> {
      prompts.push(prompt);
      if (prompt.includes("第一步：结构完整性")) {
        return JSON.stringify({ missing_sections: [], completeness_ok: true, notes: "" });
      }
      if (prompt.includes("第二步：清楚性")) {
        return JSON.stringify({ issues: [], clarity_ok: true });
      }
      if (prompt.includes("第三步：能够实现性")) {
        return JSON.stringify({ gaps: [], enablement_ok: true, skilled_person_assessment: "可实现" });
      }
      if (prompt.includes("领域特殊规则") || prompt.includes("技术领域检测")) {
        return JSON.stringify({ domain: "other", requirements: [] });
      }
      return JSON.stringify({
        sufficiently_disclosed: true,
        confidence: "high",
        key_rationale: "公开充分",
        report: "通过",
      });
    },
    async search() {
      return [];
    },
  };
}

describe("A26.3 锚点证据层", () => {
  it("anchorSpecFeatures：命中与未命中可区分", () => {
    const result = anchorSpecFeatures(CLAIM, SPEC);
    assert.ok(result.matched > 0, "应有命中特征");
    assert.ok(result.features.every(feature => typeof feature.feature === "string"));
  });

  it("enablement 子图产出 spec_anchor_evidence（确定性节点，不调 LLM）", async () => {
    const prompts: string[] = [];
    const graph = buildEnablementGraph({ includeApproval: false, ruleGate: false }).compile("load");
    const result = await graph.run(
      { claim: CLAIM, text: SPEC, source_text: SPEC },
      { provider: recordingProvider(prompts) },
    );
    const evidence = result.state.spec_anchor_evidence as { matched?: number; unmatched?: number };
    assert.ok(evidence !== undefined, "应产出 spec_anchor_evidence");
    assert.equal(typeof evidence.matched, "number");
    assert.equal(typeof evidence.unmatched, "number");
  });

  it("enablement 节点提示引用锚点证据", async () => {
    const prompts: string[] = [];
    const graph = buildEnablementGraph({ includeApproval: false, ruleGate: false }).compile("load");
    await graph.run({ claim: CLAIM, text: SPEC, source_text: SPEC }, { provider: recordingProvider(prompts) });
    const enablementPrompt = prompts.find(prompt => prompt.includes("第三步：能够实现性"));
    assert.ok(enablementPrompt, "应发出能够实现性节点提示");
    assert.match(enablementPrompt, /锚点证据/);
    assert.match(enablementPrompt, /未命中/);
  });
});

describe("金标 signals 透传（R1）", () => {
  const cases = parseDraftingGoldenJsonl(readFileSync(CORPUS, "utf8"), CORPUS);

  it("金标语料可携带子图结论（A26.3/A26.4 不再恒为未核验）", () => {
    assert.ok(cases.length >= 20);
    const withSignals = cases.filter(item => item.signals !== undefined);
    assert.equal(withSignals.length, cases.length, "全部金标都应携带子图结论信号");
    for (const item of cases) {
      assert.ok(item.signals?.enablement !== undefined, `${item.id} 缺 A26.3 信号`);
      assert.ok(item.signals?.claimBreadth !== undefined, `${item.id} 缺 A26.4 信号`);
    }
  });

  it("坏信号（布尔位写成字符串）直接报错，不静默丢弃", () => {
    assert.throws(
      () =>
        parseDraftingGoldenJsonl(
          [
            JSON.stringify({
              id: "bad-signal",
              class: "clean",
              disclosure: "d",
              claims: "c",
              spec: "s",
              signals: { claimBreadth: { supportOk: "yes" } },
            }),
          ].join("\n"),
          "inline",
        ),
      /必须是布尔值/,
    );
  });
});
