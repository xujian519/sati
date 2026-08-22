/**
 * src/patent/clarity —— 交底书清晰度准入门（第二刀）：
 * 机械信号检测 + 语义/机械融合评分 + 门判定 + HITL 强制放行。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CLARITY_THRESHOLD,
  ClarityGateHandler,
  clarityGateAtom,
  computeClarityScore,
  detectClaritySignals,
  isApprovalGateHandler,
  registerBuiltinAtoms,
  type StageProvider,
} from "../../src/patent/index.js";
import { LookupStageHandler } from "../../src/patent/atoms/index.js";

/** 四维信号齐全的最小交底书（problem/solution/effect/enablement 锚点各一）。 */
const FULL_DISCLOSURE = [
  "本发明涉及保温容器技术领域，要解决的技术问题是保温时间短的问题。",
  "技术方案：采用双层真空结构，包括保温层与内胆，通过真空层降低热传导。",
  "有益效果：保温时间由 2 小时提升至 8 小时，热损失降低 40%。",
  "实施例 1：真空度 0.1Pa，壁厚 2mm，保温 8 小时；附图 1 为整体结构示意图。",
].join("\n");

/** 信号全缺的模糊交底书。 */
const VAGUE_DISCLOSURE = "我有一个关于保温容器的发明，还请专家帮忙评估一下。";

// ---------------------------------------------------------------------------
// 机械信号检测
// ---------------------------------------------------------------------------

test("detectClaritySignals：完整交底书四维信号齐全（含证据句）", () => {
  const signals = detectClaritySignals(FULL_DISCLOSURE);
  assert.deepEqual(
    signals.map(s => [s.key, s.present]),
    [
      ["problem", true],
      ["solution", true],
      ["effect", true],
      ["enablement", true],
    ],
  );
  const problem = signals.find(s => s.key === "problem")!;
  assert.ok(problem.evidence.length > 0, "problem 应有证据");
});

test("detectClaritySignals：模糊交底书四维信号缺失（missingHint 可读）", () => {
  const signals = detectClaritySignals(VAGUE_DISCLOSURE);
  assert.deepEqual(
    signals.map(s => s.present),
    [false, false, false, false],
  );
  for (const s of signals) {
    assert.ok(s.missingHint !== undefined && s.missingHint.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 融合评分与门判定（纯函数）
// ---------------------------------------------------------------------------

test("computeClarityScore：语义+信号双高 → 通过门槛", () => {
  const s = computeClarityScore(
    { problem: 0.9, solution: 0.9, effect: 0.9, enablement: 0.9 },
    detectClaritySignals(FULL_DISCLOSURE),
  );
  assert.ok(s.clarity > 1 - CLARITY_THRESHOLD, `清晰度 ${s.clarity} 应达标`);
  assert.ok(s.passed);
  assert.equal(s.semanticOnly, false);
});

test("computeClarityScore：语义高分但信号缺失 → 融合分受机械层压制（不可跳过结构信号）", () => {
  // 四维信号全缺 + LLM 满分：clarity_i = 0.75×1 + 0.25×0 = 0.75 < 0.8 → 不达门槛。
  const s = computeClarityScore(
    { problem: 1, solution: 1, effect: 1, enablement: 1 },
    detectClaritySignals(VAGUE_DISCLOSURE),
  );
  assert.equal(s.clarity, 0.75);
  assert.ok(!s.passed, "结构信号全缺的交底书不得因语义满分而通过");
});

test("computeClarityScore：semanticOnly（无 LLM）→ 纯机械分，弱维度可定位", () => {
  const s = computeClarityScore(undefined, detectClaritySignals(FULL_DISCLOSURE));
  assert.equal(s.semanticOnly, true);
  assert.equal(s.clarity, 1, "全信号 present 的机械分应为 1");
  const partial = computeClarityScore(undefined, detectClaritySignals(`${VAGUE_DISCLOSURE}\n实施例 1：真空度 0.1Pa。`));
  assert.equal(partial.weakest.key, "problem");
});

test("computeClarityScore：边界值——清晰度 0.8（模糊度恰 0.2）通过", () => {
  // 各维 fused 0.8：semantic 0.9333(≈) + signal 0 → 0.75*0.9333=0.7 不精确；
  // 直接用 semantic 0.8 + signal 0（fused 0.6）验证未达线，用 signal 1 验证达线。
  const s0 = computeClarityScore({ problem: 0.8, solution: 0.8, effect: 0.8, enablement: 0.8 }, [
    { key: "problem", present: false },
    { key: "solution", present: false },
    { key: "effect", present: false },
    { key: "enablement", present: false },
  ]);
  assert.equal(s0.clarity, 0.6);
  assert.ok(!s0.passed);
  const s1 = computeClarityScore({ problem: 0.8, solution: 0.8, effect: 0.8, enablement: 0.8 }, [
    { key: "problem", present: true },
    { key: "solution", present: true },
    { key: "effect", present: true },
    { key: "enablement", present: true },
  ]);
  assert.equal(s1.clarity, 0.85);
  assert.ok(s1.passed);
});

// ---------------------------------------------------------------------------
// ClarityGateHandler（语义层 + 门语义 + 强制放行）
// ---------------------------------------------------------------------------

const HIGH_SCORE_PROVIDER: StageProvider = {
  callLLM: async () =>
    JSON.stringify({
      problem: 0.9,
      solution: 0.9,
      effect: 0.9,
      enablement: 0.9,
      reasons: {
        problem: "交底书明确给出技术问题",
        solution: "手段完整",
        effect: "有定量对比",
        enablement: "有实施例参数",
      },
    }),
};

const LOW_SCORE_PROVIDER: StageProvider = {
  callLLM: async () =>
    JSON.stringify({
      problem: 0.2,
      solution: 0.3,
      effect: 0.1,
      enablement: 0.2,
      reasons: { problem: "问题表述模糊", solution: "手段缺失", effect: "无定量", enablement: "无实施例" },
    }),
};

test("clarity-gate 原子声明契约", () => {
  assert.equal(clarityGateAtom.name, "clarity-gate");
  assert.deepEqual(clarityGateAtom.inputSchema, ["source_text", "text", "input"]);
  assert.deepEqual(clarityGateAtom.outputSchema, ["clarity_report", "clarity_score"]);
  assert.equal(isApprovalGateHandler(new ClarityGateHandler()), true, "clarity-gate 应支持人工放行（强制继续）");
});

test("ClarityGateHandler：高分通过 → 输出报告不中断", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("clarity-gate")!;
  const out = await h.execute({ state: { source_text: FULL_DISCLOSURE }, provider: HIGH_SCORE_PROVIDER });
  const score = JSON.parse(String(out.clarity_score)) as { passed: boolean; clarity: number };
  assert.equal(score.passed, true);
  assert.match(String(out.clarity_report), /✅ 通过/);
  assert.match(String(out.clarity_report), /技术问题清晰/);
});

test("ClarityGateHandler：低分未过 → 中断挂 HITL（含评审数据）", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("clarity-gate")!;
  await assert.rejects(
    h.execute({ state: { text: FULL_DISCLOSURE }, provider: LOW_SCORE_PROVIDER }),
    (err: unknown) => {
      const e = err as { name: string; message: string; data?: { review_context?: string; clarity_report?: string } };
      assert.equal(e.name, "InterruptStageError");
      assert.match(e.message, /清晰度未达门槛/);
      assert.match(e.data?.review_context ?? "", /编号选择：1=确认继续/);
      assert.match(e.data?.clarity_report ?? "", /未达门槛/);
      return true;
    },
  );
});

test("ClarityGateHandler：未过但已人工放行（APPROVAL_GRANTED_KEY）→ 强制继续", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("clarity-gate")!;
  const out = await h.execute({
    state: { source_text: FULL_DISCLOSURE, __approval_granted__: true },
    provider: LOW_SCORE_PROVIDER,
  });
  const score = JSON.parse(String(out.clarity_score)) as { passed: boolean };
  assert.equal(score.passed, false, "强制放行不改变评分（评分仍如实报告）");
  assert.match(String(out.clarity_report), /人工强制放行/);
});

test("ClarityGateHandler：无 LLM → 纯机械层报告（semanticOnly）", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("clarity-gate")!;
  const out = await h.execute({ state: { source_text: FULL_DISCLOSURE } });
  assert.match(String(out.clarity_report), /仅机械层/);
  const score = JSON.parse(String(out.clarity_score)) as { semanticOnly: boolean; clarity: number };
  assert.equal(score.semanticOnly, true);
  assert.equal(score.clarity, 1);
});

test("ClarityGateHandler：输入为空 → 降级", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("clarity-gate")!;
  const out = await h.execute({ state: {}, provider: HIGH_SCORE_PROVIDER });
  assert.match(String(out._error), /输入为空/);
});

test("检测信号证据被注入语义 prompt（mock 捕获）", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("clarity-gate")!;
  let captured = "";
  const provider: StageProvider = {
    callLLM: async prompt => {
      captured = prompt;
      return JSON.stringify({ problem: 0.9, solution: 0.9, effect: 0.9, enablement: 0.9 });
    },
  };
  await h.execute({ state: { source_text: FULL_DISCLOSURE }, provider });
  assert.match(captured, /机械信号/);
  assert.match(captured, /技术问题清晰/);
  assert.match(captured, /要解决的技术问题/, "证据句应出现在语义 prompt");
});
