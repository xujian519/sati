import assert from "node:assert/strict";
import test from "node:test";
import {
  AmendmentDiffHandler,
  DraftOaHandler,
  OA_DRAFT_NOTICE,
  OA_NO_CHART_REASON,
  OaGroundsHandler,
} from "../../../src/patent/atoms/handlers/builtin/oa.js";
import type { StageProvider } from "../../../src/patent/atoms/index.js";

const CHART = JSON.stringify({
  claim: "一种装置，包括壳体。",
  elements: [{ id: "1a", claimNo: 1, text: "一种装置", kind: "preamble" }],
  targets: [{ id: "D1", kind: "prior-art", title: "对比文件1" }],
  rows: [{ elementId: "1a", targetId: "D1", quote: "一种装置", pinCite: "D1 段[0010]", mapping: "literal" }],
  gaps: [],
});

const MATERIAL = [
  "## original_application",
  "本发明公开了一种装置，包括壳体和设置在壳体内的电机。",
  "## proposed_limitations",
  "- 设置在壳体内的电机",
].join("\n");

test("OaGroundsHandler: 从材料原文分型并写入主输出", async () => {
  const state = await new OaGroundsHandler().execute({
    state: { text: "权利要求1不具备新颖性和创造性。" },
  });
  const grounds = JSON.parse(state.oa_grounds as string) as { codes: string[]; unidentified: boolean };
  assert.deepEqual(grounds.codes, ["novelty", "inventiveness"]);
  assert.equal(grounds.unidentified, false);
});

test("OaGroundsHandler: 空材料得到 unidentified，不返回 _error", async () => {
  const state = await new OaGroundsHandler().execute({ state: {} });
  assert.equal(typeof state.oa_grounds, "string");
  const grounds = JSON.parse(state.oa_grounds as string) as { unidentified: boolean };
  assert.equal(grounds.unidentified, true);
});

test("AmendmentDiffHandler: 两段齐全时逐条核对", async () => {
  const state = await new AmendmentDiffHandler().execute({ state: { text: MATERIAL } });
  const diff = JSON.parse(state.amendment_diff as string) as {
    status: string;
    items: Array<{ status: string }>;
  };
  assert.equal(diff.status, "checked");
  assert.equal(diff.items[0]?.status, "anchored");
});

test("AmendmentDiffHandler: 缺标题记未核对，不产出 anchored", async () => {
  const state = await new AmendmentDiffHandler().execute({ state: { text: "只有一段普通材料。" } });
  const diff = JSON.parse(state.amendment_diff as string) as {
    status: string;
    items: Array<{ status: string }>;
  };
  assert.equal(diff.status, "not_checked");
  assert.equal(diff.items[0]?.status, "not_checked");
});

test("DraftOaHandler: 缺对照表时降级并保留草稿声明", async () => {
  const state = await new DraftOaHandler().execute({ state: {} });
  const statement = JSON.parse(state.oa_statement as string) as { status: string; reason: string; draftNotice: string };
  assert.equal(statement.status, "degraded_no_chart");
  assert.equal(statement.reason, OA_NO_CHART_REASON);
  assert.equal(statement.draftNotice, OA_DRAFT_NOTICE);
});

test("DraftOaHandler: 丢掉引用不存在的争辩段落并计数", async () => {
  const provider: StageProvider = {
    callLLM: async () =>
      JSON.stringify({
        notes: [
          { text: "1a 已在 D1 中公开。", refs: ["1a"] },
          { text: "凭空引用一个不存在的要素。", refs: ["9z"] },
          { text: "补入电机限定。", refs: ["设置在壳体内的电机"] },
        ],
      }),
  };
  const amendmentDiff = JSON.stringify({
    status: "checked",
    items: [{ limitation: "设置在壳体内的电机", status: "anchored", hits: [{ start: 12, end: 21 }] }],
  });
  const state = await new DraftOaHandler().execute({
    state: { claim_chart_doc: CHART, amendment_diff: amendmentDiff, text: MATERIAL },
    provider,
  });
  const statement = JSON.parse(state.oa_statement as string) as {
    status: string;
    argumentNotes: Array<{ text: string }>;
    droppedNotes: number;
  };
  assert.equal(statement.status, "draft");
  assert.equal(statement.argumentNotes.length, 2);
  assert.equal(statement.droppedNotes, 1);
  assert.equal(statement.argumentNotes[1]?.text, "补入电机限定。");
});

test("DraftOaHandler: 未配置模型时降级但仍保留上游结构", async () => {
  const state = await new DraftOaHandler().execute({
    state: { claim_chart_doc: CHART, oa_grounds: JSON.stringify({ codes: ["novelty"] }) },
  });
  const statement = JSON.parse(state.oa_statement as string) as {
    status: string;
    grounds: { codes: string[] };
    draftNotice: string;
  };
  assert.equal(statement.status, "degraded_no_llm");
  assert.deepEqual(statement.grounds.codes, ["novelty"]);
  assert.equal(statement.draftNotice, OA_DRAFT_NOTICE);
});
